//! One MLP neuron's write direction, read from the user's own GGUF.
//!
//! A neuron `n` of block `L` writes into the residual stream along column `n`
//! of that block's down projection. In a GGUF `blk.L.ffn_down.weight` has
//! `ne = [n_ff, n_embd]`: one row of `n_ff` values per embedding dimension,
//! quantized in blocks along the row. Column `n` is element `n` of every row,
//! so for each of the `n_embd` rows one block is read and dequantized, never
//! the whole tensor. The formulas follow ggml-quants.c `dequantize_row_*` of
//! the pinned llama.cpp; the tests check them against gguf-py's
//! `quants.dequantize` on real files.

use crate::commands::gguf::{locate_tensor, TensorAt};
use std::io::{Read, Seek, SeekFrom};

fn f16(b: &[u8]) -> f32 {
    let h = u16::from_le_bytes([b[0], b[1]]);
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = ((h >> 10) & 0x1f) as i32;
    let man = (h & 0x3ff) as f32;
    sign * match exp {
        0 => man * 2f32.powi(-24),
        31 => if man == 0.0 { f32::INFINITY } else { f32::NAN },
        e => (1.0 + man / 1024.0) * 2f32.powi(e - 15),
    }
}

fn scale_min_k4(j: usize, q: &[u8]) -> (f32, f32) {
    if j < 4 {
        ((q[j] & 63) as f32, (q[j + 4] & 63) as f32)
    } else {
        (((q[j + 4] & 0xF) | ((q[j - 4] >> 6) << 4)) as f32, ((q[j + 4] >> 4) | ((q[j] >> 6) << 4)) as f32)
    }
}

/// The ggml type names LU can read a neuron from, for the message when a
/// model uses another one.
pub const READABLE: &str = "F32, F16, BF16, Q4_0, Q4_1, Q5_0, Q5_1, Q8_0, Q2_K, Q3_K, Q4_K, Q5_K, Q6_K";

/// One block of a ggml type, dequantized. `None` for a type LU does not read.
pub fn dequantize_block(ggml_type: u32, b: &[u8]) -> Option<Vec<f32>> {
    let mut y = Vec::new();
    match ggml_type {
        0 => y.push(f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        1 => y.push(f16(b)),
        30 => y.push(f32::from_bits((u16::from_le_bytes([b[0], b[1]]) as u32) << 16)),
        // Q4_0: d, 16 bytes of nibbles; low nibbles are 0..16, high 16..32.
        2 => {
            let d = f16(&b[0..]);
            let qs = &b[2..18];
            y.resize(32, 0.0);
            for j in 0..16 {
                y[j] = ((qs[j] & 0xF) as i32 - 8) as f32 * d;
                y[j + 16] = ((qs[j] >> 4) as i32 - 8) as f32 * d;
            }
        }
        3 => {
            let (d, m) = (f16(&b[0..]), f16(&b[2..]));
            let qs = &b[4..20];
            y.resize(32, 0.0);
            for j in 0..16 {
                y[j] = (qs[j] & 0xF) as f32 * d + m;
                y[j + 16] = (qs[j] >> 4) as f32 * d + m;
            }
        }
        6 | 7 => {
            let one = ggml_type == 7;
            let d = f16(&b[0..]);
            let (m, rest) = if one { (f16(&b[2..]), &b[4..]) } else { (0.0, &b[2..]) };
            let qh = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]);
            let qs = &rest[4..20];
            y.resize(32, 0.0);
            for j in 0..16 {
                let h0 = (((qh >> j) << 4) & 0x10) as u8;
                let h1 = ((qh >> (j + 12)) & 0x10) as u8;
                let x0 = ((qs[j] & 0xF) | h0) as i32;
                let x1 = ((qs[j] >> 4) | h1) as i32;
                if one {
                    y[j] = x0 as f32 * d + m;
                    y[j + 16] = x1 as f32 * d + m;
                } else {
                    y[j] = (x0 - 16) as f32 * d;
                    y[j + 16] = (x1 - 16) as f32 * d;
                }
            }
        }
        8 => {
            let d = f16(&b[0..]);
            y.extend(b[2..34].iter().map(|&q| q as i8 as f32 * d));
        }
        // Q2_K: scales[16], qs[64], d, dmin.
        10 => {
            let (sc, qs) = (&b[0..16], &b[16..80]);
            let (d, min) = (f16(&b[80..]), f16(&b[82..]));
            let mut is = 0;
            for n in (0..256).step_by(128) {
                let q = &qs[n / 4..];
                let mut shift = 0;
                for _ in 0..4 {
                    for half in 0..2 {
                        let s = sc[is];
                        is += 1;
                        let (dl, ml) = (d * (s & 0xF) as f32, min * (s >> 4) as f32);
                        for l in 0..16 {
                            y.push(dl * ((q[l + 16 * half] >> shift) & 3) as f32 - ml);
                        }
                    }
                    shift += 2;
                }
            }
        }
        // Q3_K: hmask[32], qs[64], scales[12], d.
        11 => {
            let (hm, qs, raw) = (&b[0..32], &b[32..96], &b[96..108]);
            let d = f16(&b[108..]);
            let a = |i: usize| u32::from_le_bytes([raw[4 * i], raw[4 * i + 1], raw[4 * i + 2], raw[4 * i + 3]]);
            let (k1, k2) = (0x0303_0303u32, 0x0f0f_0f0fu32);
            let tmp = a(2);
            let aux = [
                (a(0) & k2) | ((tmp & k1) << 4),
                (a(1) & k2) | (((tmp >> 2) & k1) << 4),
                ((a(0) >> 4) & k2) | (((tmp >> 4) & k1) << 4),
                ((a(1) >> 4) & k2) | (((tmp >> 6) & k1) << 4),
            ];
            let scales: Vec<i8> = aux.iter().flat_map(|w| w.to_le_bytes()).map(|x| x as i8).collect();
            let (mut is, mut m) = (0, 1u8);
            for n in (0..256).step_by(128) {
                let q = &qs[n / 4..];
                let mut shift = 0;
                for _ in 0..4 {
                    for half in 0..2 {
                        let dl = d * (scales[is] as i32 - 32) as f32;
                        is += 1;
                        for l in 0..16 {
                            let k = l + 16 * half;
                            let hi = if hm[k] & m != 0 { 0 } else { 4 };
                            y.push(dl * (((q[k] >> shift) & 3) as i32 - hi) as f32);
                        }
                    }
                    shift += 2;
                    m <<= 1;
                }
            }
        }
        // Q4_K: d, dmin, scales[12], qs[128].
        12 => {
            let (d, min) = (f16(&b[0..]), f16(&b[2..]));
            let (sc, qs) = (&b[4..16], &b[16..144]);
            for (k, j) in (0..256).step_by(64).enumerate() {
                let q = &qs[j / 2..j / 2 + 32];
                let (s1, m1) = scale_min_k4(2 * k, sc);
                let (s2, m2) = scale_min_k4(2 * k + 1, sc);
                y.extend(q.iter().map(|&x| d * s1 * (x & 0xF) as f32 - min * m1));
                y.extend(q.iter().map(|&x| d * s2 * (x >> 4) as f32 - min * m2));
            }
        }
        // Q5_K: d, dmin, scales[12], qh[32], qs[128].
        13 => {
            let (d, min) = (f16(&b[0..]), f16(&b[2..]));
            let (sc, qh, qs) = (&b[4..16], &b[16..48], &b[48..176]);
            let (mut u1, mut u2) = (1u8, 2u8);
            for (k, j) in (0..256).step_by(64).enumerate() {
                let q = &qs[j / 2..j / 2 + 32];
                let (s1, m1) = scale_min_k4(2 * k, sc);
                let (s2, m2) = scale_min_k4(2 * k + 1, sc);
                for l in 0..32 {
                    let h = if qh[l] & u1 != 0 { 16 } else { 0 };
                    y.push(d * s1 * ((q[l] & 0xF) + h) as f32 - min * m1);
                }
                for l in 0..32 {
                    let h = if qh[l] & u2 != 0 { 16 } else { 0 };
                    y.push(d * s2 * ((q[l] >> 4) + h) as f32 - min * m2);
                }
                u1 <<= 2;
                u2 <<= 2;
            }
        }
        // Q6_K: ql[128], qh[64], scales[16] (i8), d.
        14 => {
            let (ql, qh, sc) = (&b[0..128], &b[128..192], &b[192..208]);
            let d = f16(&b[208..]);
            y.resize(256, 0.0);
            for half in 0..2 {
                let (ql, qh, sc, out) = (&ql[64 * half..], &qh[32 * half..], &sc[8 * half..], 128 * half);
                for l in 0..32 {
                    let is = l / 16;
                    let q1 = ((ql[l] & 0xF) | ((qh[l] & 3) << 4)) as i32 - 32;
                    let q2 = ((ql[l + 32] & 0xF) | (((qh[l] >> 2) & 3) << 4)) as i32 - 32;
                    let q3 = ((ql[l] >> 4) | (((qh[l] >> 4) & 3) << 4)) as i32 - 32;
                    let q4 = ((ql[l + 32] >> 4) | (((qh[l] >> 6) & 3) << 4)) as i32 - 32;
                    y[out + l] = d * sc[is] as i8 as f32 * q1 as f32;
                    y[out + l + 32] = d * sc[is + 2] as i8 as f32 * q2 as f32;
                    y[out + l + 64] = d * sc[is + 4] as i8 as f32 * q3 as f32;
                    y[out + l + 96] = d * sc[is + 6] as i8 as f32 * q4 as f32;
                }
            }
        }
        _ => return None,
    }
    Some(y)
}

/// Column `col` of a 2-D tensor stored as `ne = [cols, rows]`: element `col`
/// of every row.
pub fn read_column(t: &TensorAt, col: u64) -> Result<Vec<f32>, String> {
    let (cols, rows) = match t.info.dims.as_slice() {
        [c, r] => (*c, *r),
        _ => return Err(format!("{} is not a matrix.", t.info.name)),
    };
    if col >= cols {
        return Err(format!("This layer has {cols} neurons, numbered 0 to {}.", cols - 1));
    }
    let (per_block, block_bytes) = crate::commands::gguf::ggml_type_block(t.info.ggml_type).ok_or("unknown weight type")?;
    if cols % per_block != 0 {
        return Err("The weights of this layer are not stored in whole blocks.".into());
    }
    let row_bytes = cols / per_block * block_bytes;
    let mut f = std::io::BufReader::new(std::fs::File::open(&t.file).map_err(|e| crate::os_error::english(&e))?);
    let mut block = vec![0u8; block_bytes as usize];
    let mut out = Vec::with_capacity(rows as usize);
    for r in 0..rows {
        let pos = t.at + r * row_bytes + (col / per_block) * block_bytes;
        f.seek(SeekFrom::Start(pos)).map_err(|e| crate::os_error::english(&e))?;
        f.read_exact(&mut block).map_err(|e| crate::os_error::english(&e))?;
        let values = dequantize_block(t.info.ggml_type, &block)
            .ok_or_else(|| format!("This model stores the layer in a format LU cannot read for single neurons (ggml type {}). It reads {READABLE}.", t.info.ggml_type))?;
        out.push(values[(col % per_block) as usize]);
    }
    Ok(out)
}

/// Neuron `neuron` of block `layer`: its write direction and the number of
/// neurons in that block.
pub fn neuron_column(model_path: &str, layer: usize, neuron: u64) -> Result<(Vec<f32>, u64), String> {
    let name = format!("blk.{layer}.ffn_down.weight");
    let t = locate_tensor(model_path, &name).ok_or_else(|| format!("Layer {layer} of this model has no dense MLP (no {name}), so it has no single neurons to turn."))?;
    let n_ff = t.info.dims.first().copied().unwrap_or(0);
    Ok((read_column(&t, neuron)?, n_ff))
}

/// Neurons per block, from the first block's down projection; `None` when
/// the model has no dense MLP there (a mixture of experts, say).
pub fn neurons_per_layer(model_path: &str) -> Option<u64> {
    locate_tensor(model_path, "blk.0.ffn_down.weight").and_then(|t| (t.info.dims.len() == 2).then(|| t.info.dims[0]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(x: f32) -> [u8; 2] {
        // Exact for the small powers of two the tests use.
        let bits = x.to_bits();
        let sign = ((bits >> 16) & 0x8000) as u16;
        let exp = ((bits >> 23) & 0xff) as i32 - 127 + 15;
        let man = ((bits >> 13) & 0x3ff) as u16;
        (if x == 0.0 { 0 } else { sign | ((exp as u16) << 10) | man }).to_le_bytes()
    }

    #[test]
    fn halves_read_like_ggml() {
        assert_eq!(f16(&h(1.0)), 1.0);
        assert_eq!(f16(&h(-0.5)), -0.5);
        assert_eq!(f16(&[0x00, 0x3c]), 1.0);
        assert_eq!(f16(&[0x01, 0x00]), 2f32.powi(-24));
    }

    #[test]
    fn q8_0_and_q4_0_blocks_dequantize() {
        let mut b = h(0.5).to_vec();
        b.extend((0..32).map(|i| (i as i8 - 16) as u8));
        let y = dequantize_block(8, &b).unwrap();
        assert_eq!(y.len(), 32);
        assert_eq!((y[0], y[16], y[31]), (-8.0, 0.0, 7.5));

        let mut b = h(2.0).to_vec();
        b.extend((0..16).map(|j| (j as u8) | (15 - j as u8) << 4));
        let y = dequantize_block(2, &b).unwrap();
        assert_eq!((y[0], y[15], y[16], y[31]), (-16.0, 14.0, 14.0, -16.0));
    }

    #[test]
    fn q4_k_uses_the_six_bit_scales() {
        // d = 1, dmin = 0.5, scale 2 and min 1 for the first 32, q = 3.
        let mut b = h(1.0).to_vec();
        b.extend(h(0.5));
        let mut sc = [0u8; 12];
        sc[0] = 2;
        sc[4] = 1;
        b.extend(sc);
        b.extend([0x03u8; 128]);
        let y = dequantize_block(12, &b).unwrap();
        assert_eq!(y.len(), 256);
        assert_eq!(y[0], 2.0 * 3.0 - 0.5);
        // The next 32 (high nibbles, scale index 1) have scale 0, min 0.
        assert_eq!(y[32], 0.0);
    }

    #[test]
    fn a_type_lu_does_not_read_is_named() {
        assert!(dequantize_block(16, &[0u8; 66]).is_none());
    }

    /// Real files against gguf-py (llama.cpp's own Python reader): with
    /// `LU_COLUMN_CHECK=model.gguf|layer|neuron|out.txt` (or a tensor name for the layer) it writes the column
    /// LU reads; `scripts/neuron/column-check.py` dequantizes the whole
    /// tensor with gguf-py and compares. Without the variable it does nothing.
    #[test]
    #[ignore = "needs a real model; run by hand with LU_COLUMN_CHECK"]
    fn a_real_column_for_the_reference_check() {
        let Ok(spec) = std::env::var("LU_COLUMN_CHECK") else { return };
        let parts: Vec<&str> = spec.split('|').collect();
        // A layer number reads a neuron; a tensor name reads that tensor
        // (to reach types a model only uses outside the down projection).
        let (col, n_ff) = match parts[1].parse::<usize>() {
            Ok(layer) => neuron_column(parts[0], layer, parts[2].parse().unwrap()).unwrap(),
            Err(_) => {
                let t = locate_tensor(parts[0], parts[1]).unwrap();
                (read_column(&t, parts[2].parse().unwrap()).unwrap(), t.info.dims[0])
            }
        };
        let text: Vec<String> = col.iter().map(|x| format!("{x:e}")).collect();
        std::fs::write(parts[3], format!("{n_ff}\n{}\n", text.join("\n"))).unwrap();
    }

    #[test]
    fn a_column_is_one_element_of_every_row() {
        // ne = [64, 3] in Q8_0: two blocks per row, d = 1, q = row*100 + col
        // (clamped into i8 by staying small).
        let dir = crate::os_paths::test_dir("neuron-column");
        let p = dir.join("w.bin");
        let mut raw = Vec::new();
        for r in 0..3i32 {
            for blk in 0..2i32 {
                raw.extend(h(1.0));
                raw.extend((0..32).map(|i| (r * 40 + blk * 32 + i - 60) as i8 as u8));
            }
        }
        std::fs::write(&p, &raw).unwrap();
        let t = TensorAt {
            info: crate::commands::gguf::TensorInfo { name: "w".into(), dims: vec![64, 3], ggml_type: 8 },
            file: p.clone(),
            at: 0,
        };
        assert_eq!(read_column(&t, 40).unwrap(), vec![-20.0, 20.0, 60.0]);
        assert!(read_column(&t, 64).unwrap_err().contains("0 to 63"));
    }
}
