// Unit tests for scripts/win-isa-guard.mjs against small, checked-in fixture
// excerpts (scripts/__fixtures__/win-isa/), not the multi-MB real dumpbin
// dumps from lu-301/e2e/k1-avx/, which stay out of the repo. Run with:
//   node --test scripts/win-isa-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseDisasmLines,
  parseMapSymbols,
  findVexEvexHits,
  isVexEvexHit,
  findOwner,
  isAllowlisted,
  hasApxRegisterOperand,
  checkDominance,
  evaluateModule,
} from './win-isa-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'win-isa');

function loadFixture(name) {
  return {
    disasmText: readFileSync(join(FIXTURES, `${name}.disasm.txt`), 'utf8'),
    mapText: readFileSync(join(FIXTURES, `${name}.map.txt`), 'utf8'),
  };
}

test('R1: VEX/EVEX detection is by opcode byte, not mnemonic spelling', () => {
  const lines = parseDisasmLines([
    '  0000000180000000: C5 F9 6E D8        vmovd       xmm3,eax',
    '  0000000180000004: C4 E3 65 18 DB 01  vinsertf128 ymm3,ymm3,xmm3,1',
    '  0000000180000010: 62 F2 F5 08 40 C6  vpmullq     xmm0,xmm1,xmm6',
    // verr/verw real opcode is 0F 00 /4 /5, first byte 0F, never C4/C5/62.
    '  0000000180000020: 0F 00 34 25 00 00  verr        word ptr [0]',
    '  0000000180000030: 48 89 5C 24 08     mov         qword ptr [rsp+8],rbx',
  ].join('\n'));
  assert.equal(lines.length, 5);
  const hits = findVexEvexHits(lines);
  assert.equal(hits.length, 3, 'exactly the three real VEX/EVEX lines, verr/verw and mov excluded');
  assert.ok(hits.every((h) => isVexEvexHit(h)));
});

test('R1: a dumpbin continuation line (no address) is not parsed as its own instruction', () => {
  // Real dumpbin wraps long instructions onto a second line with no leading
  // address; that line must simply not match, not be mis-read as a hit.
  const lines = parseDisasmLines([
    '  0000000180000000: 48 8D 05 00 00 00 00',
    '                    00                 lea         rax,[rip]',
  ].join('\n'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].addr, 0x180000000);
});

test('.map row parsing: Lib:Object is the trailing token, f/i flags are stripped', () => {
  const symbols = parseMapSymbols([
    ' 0001:00091000       __std_find_trivial_1       0000000180092000 f   msvcprt:vector_algorithms.obj',
    ' 0003:000001b8       __isa_available            00000001800b51b8     MSVCRT:cpu_disp.obj',
    ' 0002:00020784       __NULL_IMPORT_DESCRIPTOR   00000001800b3784     ggml-base:ggml-base.dll',
  ].join('\n'));
  assert.equal(symbols.length, 3);
  const find = symbols.find((s) => s.name === '__std_find_trivial_1');
  assert.equal(find.obj, 'msvcprt:vector_algorithms.obj');
  assert.equal(find.va, 0x180092000);
  const isa = symbols.find((s) => s.name === '__isa_available');
  assert.equal(isa.obj, 'MSVCRT:cpu_disp.obj');
});

test('findOwner: largest symbol address <= target, function end is the next symbol', () => {
  const symbols = parseMapSymbols([
    ' 0001:00000000       f_one   0000000180001000 f   a.obj',
    ' 0001:00000100       f_two   0000000180001100 f   b.obj',
  ].join('\n'));
  const owned = findOwner(symbols, 0x180001050);
  assert.equal(owned.owner.name, 'f_one');
  assert.equal(owned.functionEnd, 0x180001100);
  assert.equal(findOwner(symbols, 0x180000fff), null, 'address before every symbol has no owner');
});

test('isAllowlisted: msvcprt:vector_algorithms.obj, MSVCRT:*, and wmemcmp/memcmp bound to a known host object are allowed; own code is not', () => {
  assert.equal(isAllowlisted({ obj: 'msvcprt:vector_algorithms.obj', name: 'x' }), true);
  assert.equal(isAllowlisted({ obj: 'MSVCRT:cpu_disp.obj', name: 'x' }), true);
  assert.equal(isAllowlisted({ obj: 'common.obj', name: 'wmemcmp' }), true);
  assert.equal(isAllowlisted({ obj: 'unicode.obj', name: 'memcmp' }), true);
  assert.equal(isAllowlisted({ obj: 'ggml-backend-reg.obj', name: 'wmemcmp' }), true);
  assert.equal(isAllowlisted({ obj: 'server-context.obj', name: 'wmemcmp' }), true);
  // 3.1.2: the b11960 layout hands the same reviewed wmemcmp COMDAT to these.
  assert.equal(isAllowlisted({ obj: 'arg.obj', name: 'wmemcmp' }), true);
  assert.equal(isAllowlisted({ obj: 'server-connect.obj', name: 'wmemcmp' }), true);
  // Only that exact symbol: other code in those objects stays checked.
  assert.equal(isAllowlisted({ obj: 'arg.obj', name: 'common_params_parse' }), false);
  assert.equal(isAllowlisted({ obj: 'ggml-quants.obj', name: 'iq2xs_init_impl$omp$1' }), false);
});

test('BL3 (review-waechter-windows.md): a mangled name containing "memcmp" as a mere substring is NOT allowlisted', () => {
  // Opus's counter-example: a C++ namespace/function literally called
  // "memcmp" inside an unrelated, unguarded own-code object. The old
  // \bmemcmp\b regex matched this via the word boundaries around "@memcmp@"
  // and waved it through as ALLOWED_CRT even though ggml-cpu.obj was never
  // reviewed and never carries a self-guarding CRT dispatch.
  assert.equal(isAllowlisted({ obj: 'ggml-cpu.obj', name: '?fast@memcmp@ggml@@YAXXZ' }), false);
});

test('BL3: exact name "memcmp"/"wmemcmp" in an object OUTSIDE the reviewed host list is NOT allowlisted', () => {
  // Even an EXACT name match must still be bound to one of the specific
  // objects review-k1-avx.md actually verified; a symbol named exactly
  // "memcmp" turning up in some other object was never checked and must
  // fall through to the ordinary dominance check like any other own code.
  assert.equal(isAllowlisted({ obj: 'ggml-cpu.obj', name: 'memcmp' }), false);
  assert.equal(isAllowlisted({ obj: 'ggml-cpu.obj', name: 'wmemcmp' }), false);
});

test('checkDominance: finds the isa-read-then-guarding-jump shape (Fundstelle 2a pattern)', () => {
  const lines = parseDisasmLines([
    '  0000000180027ED6: 8B 0D BC 19 07 00  mov         ecx,dword ptr [0000000180099898h]',
    '  0000000180027F7E: 83 F9 05           cmp         ecx,5',
    '  0000000180027F81: 7C 40              jl          0000000180027FC3',
    '  0000000180027F83: C4 C2 71 46 C2     vpsravd     xmm0,xmm1,xmm10',
    '  0000000180027FC3: 48 8D 94 24 88 00  lea         rdx,[rsp+88h]',
  ].join('\n'));
  const dom = checkDominance(lines, [0x180099898], 0x180027e10, 0x180028010, 0x180027f83);
  assert.equal(dom.protected, true);
});

test('checkDominance: an isa read with no bounding jump is NOT protected', () => {
  const lines = parseDisasmLines([
    '  0000000180027ED6: 8B 0D BC 19 07 00  mov         ecx,dword ptr [0000000180099898h]',
    '  0000000180027F83: C4 C2 71 46 C2     vpsravd     xmm0,xmm1,xmm10',
  ].join('\n'));
  const dom = checkDominance(lines, [0x180099898], 0x180027e10, 0x180028010, 0x180027f83);
  assert.equal(dom.protected, false);
});

test('N1 (review-waechter-windows.md): an isa read followed by an UNRELATED conditional jump that happens to land past the hit is NOT protected', () => {
  // Fake-green pattern A: the isa read is real, but the jump that reaches
  // past the hit comes from a completely different comparison (here, on a
  // different register) that never looked at the isa flag.
  const lines = parseDisasmLines([
    '  0000000180060000: 8B 0D BC 19 07 00  mov         ecx,dword ptr [0000000180099898h]',
    '  0000000180060010: 48 85 C0           test        rax,rax',
    '  0000000180060014: 74 1A              je          0000000180060030',
    '  0000000180060020: C5 F9 6E D8        vmovd       xmm3,eax',
  ].join('\n'));
  const dom = checkDominance(lines, [0x180099898], 0x180060000, 0x180060100, 0x180060020);
  assert.equal(dom.protected, false);
});

test('N1: the isa ADDRESS used only as a bare immediate (never dereferenced) does not count as a read', () => {
  // Fake-green pattern F: the isa flag's address appears in the instruction
  // text, but only as a constant loaded into a register, never dereferenced,
  // so the flag's actual value is never inspected.
  const lines = parseDisasmLines([
    '  0000000180070000: 48 B8 98 98 09 80 01 00 00 00  mov  rax,0000000180099898h',
    '  0000000180070010: 48 85 C0                       test rax,rax',
    '  0000000180070014: 74 1A                          je   0000000180070030',
    '  0000000180070020: C5 F9 6E D8                    vmovd xmm3,eax',
  ].join('\n'));
  const dom = checkDominance(lines, [0x180099898], 0x180070000, 0x180070100, 0x180070020);
  assert.equal(dom.protected, false);
});

test('N1: an instruction that WRITES EFLAGS between the bound cmp/test and the jump breaks the binding', () => {
  const lines = parseDisasmLines([
    '  0000000180027ED6: 8B 0D BC 19 07 00  mov         ecx,dword ptr [0000000180099898h]',
    '  0000000180027F7E: 83 F9 05           cmp         ecx,5',
    '  0000000180027F80: 48 85 C0           test        rax,rax',
    '  0000000180027F81: 7C 40              jl          0000000180027FC3',
    '  0000000180027F83: C4 C2 71 46 C2     vpsravd     xmm0,xmm1,xmm10',
  ].join('\n'));
  const dom = checkDominance(lines, [0x180099898], 0x180027e10, 0x180028010, 0x180027f83);
  assert.equal(dom.protected, false, 'the test rax,rax overwrote the flags, so the jl no longer evaluates the isa compare');
});

// Form (i)/A, see FLAG_PRESERVING_MNEMONICS in win-isa-guard.mjs and the
// fixture pair scheduled-jump-own-code.* / scheduled-jump-no-guard-own-code.*
// this pair of tests mirrors in miniature.
test('form (i): movs between the bound cmp/test and the jump are followed across, because they cannot write EFLAGS', () => {
  const lines = parseDisasmLines([
    '  000000018007A974: 83 3D 15 10 19 00  cmp         dword ptr [000000018020B990h],6',
    '  000000018007A97B: 4C 8B 19           mov         r11,qword ptr [rcx]',
    '  000000018007A97E: 0F 8C CA 00 00 00  jl          000000018007AA4E',
    '  000000018007AA0D: 62 F2 FD 08 40 D5  vpmullq     xmm2,xmm0,xmm5',
    '  000000018007AA4E: 48 89 5C 24 20     mov         qword ptr [rsp+20h],rbx',
  ].join('\n'));
  const dom = checkDominance(lines, [0x18020b990], 0x18007a970, 0x18007ab80, 0x18007aa0d);
  assert.equal(dom.protected, true, 'the real MSVC 14.51 shape from llama.dll, lu-301/bau/isa-review-1451.md section 2');
});

test('form (i) is not a free pass: the same shape without the conditional jump stays unprotected', () => {
  const lines = parseDisasmLines([
    '  000000018007A974: 83 3D 15 10 19 00  cmp         dword ptr [000000018020B990h],6',
    '  000000018007A97B: 4C 8B 19           mov         r11,qword ptr [rcx]',
    '  000000018007AA0D: 62 F2 FD 08 40 D5  vpmullq     xmm2,xmm0,xmm5',
  ].join('\n'));
  const dom = checkDominance(lines, [0x18020b990], 0x18007a970, 0x18007ab80, 0x18007aa0d);
  assert.equal(dom.protected, false);
});

test('form (i) stops at the cap: more scheduled movs than MAX_SCHEDULED_INSTRUCTIONS_BEFORE_JUMP is not followed', () => {
  const movs = [];
  for (let i = 0; i < 9; i += 1) {
    const addr = (0x18007a980 + i * 3).toString(16).padStart(16, '0').toUpperCase();
    movs.push(`  ${addr}: 4C 8B 19           mov         r11,qword ptr [rcx]`);
  }
  const lines = parseDisasmLines([
    '  000000018007A974: 83 3D 15 10 19 00  cmp         dword ptr [000000018020B990h],6',
    ...movs,
    '  000000018007A9A0: 0F 8C CA 00 00 00  jl          000000018007AA4E',
    '  000000018007AA0D: 62 F2 FD 08 40 D5  vpmullq     xmm2,xmm0,xmm5',
    '  000000018007AA4E: 48 89 5C 24 20     mov         qword ptr [rsp+20h],rbx',
  ].join('\n'));
  const dom = checkDominance(lines, [0x18020b990], 0x18007a970, 0x18007ab80, 0x18007aa0d);
  assert.equal(dom.protected, false);
});

test('fixture: scheduled-jump-own-code (real MSVC 14.51 llama.dll form (i)) -> ALLOWED_PROTECTED', () => {
  const { disasmText, mapText } = loadFixture('scheduled-jump-own-code');
  const result = evaluateModule({ moduleName: 'scheduled-jump-own-code', disasmText, mapText });
  assert.equal(result.hitCount, 2, 'both vpmullq are VEX/EVEX hits');
  assert.equal(result.ownedHitCount, 2);
  assert.equal(result.decodeArtifactCount, 0, 'xmm0/xmm2/xmm5 are not APX registers');
  assert.equal(result.unprotected.length, 0);
  for (const v of result.verdicts) {
    assert.equal(v.verdict, 'ALLOWED_PROTECTED');
    assert.equal(v.owner.obj, 'llama-kv-cache.obj', 'own code, so the CRT allowlist must not be what saved it');
  }
});

test('fixture: scheduled-jump-no-guard-own-code (the same form with the jump removed) MUST stay UNPROTECTED', () => {
  const { disasmText, mapText } = loadFixture('scheduled-jump-no-guard-own-code');
  const result = evaluateModule({ moduleName: 'scheduled-jump-no-guard-own-code', disasmText, mapText });
  assert.equal(result.hitCount, 2);
  assert.equal(result.unprotected.length, 2);
  for (const v of result.verdicts) assert.equal(v.verdict, 'UNPROTECTED');
});

test('fixture: fake-unrelated-jump-own-code (Opus pattern A) MUST come out UNPROTECTED', () => {
  const { disasmText, mapText } = loadFixture('fake-unrelated-jump-own-code');
  const result = evaluateModule({ moduleName: 'fake-unrelated-jump-own-code', disasmText, mapText });
  assert.equal(result.hitCount, 1);
  assert.equal(result.unprotected.length, 1);
  assert.equal(result.verdicts[0].verdict, 'UNPROTECTED');
});

test('fixture: fake-address-as-constant-own-code (Opus pattern F) MUST come out UNPROTECTED', () => {
  const { disasmText, mapText } = loadFixture('fake-address-as-constant-own-code');
  const result = evaluateModule({ moduleName: 'fake-address-as-constant-own-code', disasmText, mapText });
  assert.equal(result.hitCount, 1);
  assert.equal(result.unprotected.length, 1);
  assert.equal(result.verdicts[0].verdict, 'UNPROTECTED');
});

test('R7: hasApxRegisterOperand matches r16-r31 in any operand position and nothing else', () => {
  const apx = parseDisasmLines([
    '  0000000180097301: 62 51 04 CC 56 39  vorps       zmm25{k4}{z},zmm15,zmmword ptr [r25]',
    '  00000001800DCADC: 62 02 05 00 00 08  vpshufb     xmm16,xmm30,xmmword ptr [r25]',
    '  0000000180000010: 62 00 00 00 00 00  vmovups     ymm0,ymmword ptr [rax+r31*8]',
    '  0000000180000020: 62 00 00 00 00 00  vmovd       xmm0,r16d',
    '  0000000180000030: 62 00 00 00 00 00  vmovd       xmm0,r31b',
  ].join('\n'));
  assert.equal(apx.length, 5);
  for (const line of apx) {
    assert.equal(hasApxRegisterOperand(line), true, `expected an APX register in: ${line.text}`);
  }

  const notApx = parseDisasmLines([
    // Every AVX-512 spelling on its own is NOT evidence of a misdecode:
    // MSVC does emit zmm, k-masks and {z} under /arch:AVX512.
    '  0000000180000040: 62 F1 6C C9 56 0C  vorps       zmm1{k1}{z},zmm2,zmmword ptr [rsp]',
    '  0000000180000050: 62 02 05 00 00 08  vpshufb     xmm16,xmm30,xmmword ptr [rcx]',
    // The legacy register file, including the r8-r15 names the regex must
    // not over-reach into, and control/debug registers whose spelling ends
    // in digits that would match without the leading word boundary.
    '  0000000180000060: C5 F9 6E D8        vmovd       xmm3,eax',
    '  0000000180000070: C4 C2 71 46 C2     vpsravd     xmm0,xmm1,xmm10',
    '  0000000180000080: C5 FA 6F 04 CF     vmovdqu     xmm0,xmmword ptr [rdi+r9*8]',
    '  0000000180000090: 0F 20 C1           mov         rcx,cr16',
    '  00000001800000A0: 0F 21 C1           mov         rcx,dr16',
  ].join('\n'));
  assert.equal(notApx.length, 7);
  for (const line of notApx) {
    assert.equal(hasApxRegisterOperand(line), false, `did not expect an APX register in: ${line.text}`);
  }
});

test('R7 fixture: the CI line from mtmd.dll is DECODE_ARTIFACT_APX, a real zmm hit without APX registers stays UNPROTECTED', () => {
  // Positive and negative in one module, on purpose: the whole point of R7
  // is that it excuses the APX misdecode and NOTHING else, so the fixture
  // has to show a genuine, unguarded AVX-512 instruction in the same
  // own-code object still going red, and the module still failing.
  const { disasmText, mapText } = loadFixture('apx-decode-artifact');
  const result = evaluateModule({ moduleName: 'apx-decode-artifact', disasmText, mapText });
  assert.equal(result.hitCount, 2);
  assert.equal(result.ownedHitCount, 2, 'the artifact is still resolved to an owner, so the R4 map control stays as strict as before');
  assert.equal(result.decodeArtifactCount, 1);

  const [artifact, real] = result.verdicts;
  assert.equal(artifact.verdict, 'DECODE_ARTIFACT_APX');
  assert.equal(artifact.hit.addr, 0x180097301);
  assert.equal(artifact.owner.name, '$LN4275');
  assert.equal(artifact.owner.obj, 'clip.obj');
  assert.match(artifact.hit.text, /zmmword ptr \[r25\]/);

  assert.equal(real.verdict, 'UNPROTECTED');
  assert.equal(real.owner.name, 'clip_own_avx512_kernel');
  assert.equal(result.unprotected.length, 1, 'only the real hit is unprotected; the artifact must not be counted');
  assert.equal(result.unprotected[0], real);
});

test('R7: no allowlist by file name, the decision reads the operands only', () => {
  // The same two clip.obj hits under a different module and object name
  // must get exactly the same verdicts: nothing in R7 keys on clip.obj or
  // mtmd.dll, which is what keeps this from being an allowlist in disguise.
  const { disasmText } = loadFixture('apx-decode-artifact');
  const mapText = [
    ' Static symbols',
    '',
    ' 0001:00000000       some_other_label          0000000180097300 f   ggml-cpu.obj',
    ' 0001:00000110       some_other_kernel         0000000180097410 f   ggml-cpu.obj',
    ' 0001:00000210       some_other_kernel_end     0000000180097510 f   ggml-cpu.obj',
    ' 0003:00000010       __isa_available           0000000180099898     MSVCRT:cpu_disp.obj',
  ].join('\n');
  const result = evaluateModule({ moduleName: 'renamed', disasmText, mapText });
  assert.equal(result.verdicts[0].verdict, 'DECODE_ARTIFACT_APX');
  assert.equal(result.verdicts[1].verdict, 'UNPROTECTED');
});

test('R7: the artifact is reported, not swallowed, and the CLI still exits 1 on the real hit next to it', () => {
  const script = join(HERE, 'win-isa-guard.mjs');
  const result = spawnSync(process.execPath, [
    script, 'check', '--module', 'apx-decode-artifact', '--min-lines', '0',
    '--disasm', join(FIXTURES, 'apx-decode-artifact.disasm.txt'),
    '--map', join(FIXTURES, 'apx-decode-artifact.map.txt'),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1, `expected exit 1 (the second, real hit), got ${result.status}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /\[DECODE_ARTIFACT_APX\]/, 'the artifact appears as its own verdict class in the per-hit report');
  assert.match(result.stdout, /NOTE: apx-decode-artifact: 1 hit\(s\) classified DECODE_ARTIFACT_APX/, 'and again as a counted summary line');
  assert.match(result.stderr, /has 1 unprotected VEX\/EVEX instruction\(s\)/);
});

test('R7: a module whose ONLY hit is the APX artifact comes out green, with the artifact still on the record', () => {
  // This is the mtmd.dll case as it will look on the next CI run: the one
  // hit that made the release red is the misdecode, so the module passes,
  // but the line and the count stay in the log.
  const script = join(HERE, 'win-isa-guard.mjs');
  const disasmOnlyArtifact = join(FIXTURES, '.tmp-apx-only.disasm.txt');
  const mapOnlyArtifact = join(FIXTURES, '.tmp-apx-only.map.txt');
  writeFileSync(disasmOnlyArtifact, [
    '  0000000180097301: 62 51 04 CC 56 39  vorps       zmm25{k4}{z},zmm15,zmmword ptr [r25]',
    '  0000000180097307: C3                 ret',
    '',
  ].join('\n'));
  writeFileSync(mapOnlyArtifact, readFileSync(join(FIXTURES, 'apx-decode-artifact.map.txt'), 'utf8'));
  try {
    const result = spawnSync(process.execPath, [
      script, 'check', '--module', 'mtmd.dll', '--min-lines', '0',
      '--disasm', disasmOnlyArtifact, '--map', mapOnlyArtifact,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /\[DECODE_ARTIFACT_APX\]/);
    assert.match(result.stdout, /NOTE: mtmd\.dll: 1 hit\(s\) classified DECODE_ARTIFACT_APX/);
    assert.match(result.stdout, /OK: mtmd\.dll, no unprotected VEX\/EVEX in own code/);
  } finally {
    rmSync(disasmOnlyArtifact, { force: true });
    rmSync(mapOnlyArtifact, { force: true });
  }
});

test('R7 does not loosen the other fixtures: the red probe and both fake-green shapes stay red', () => {
  // A guard rule that excuses a class of hit is exactly the kind of change
  // that can quietly take the existing probes with it, so they are asserted
  // again from here rather than only in their own tests above.
  const stillRed = [
    ['unprotected-own-code', 1],
    ['fake-unrelated-jump-own-code', 1],
    ['fake-address-as-constant-own-code', 1],
    ['scheduled-jump-no-guard-own-code', 2],
  ];
  for (const [name, expected] of stillRed) {
    const { disasmText, mapText } = loadFixture(name);
    const result = evaluateModule({ moduleName: name, disasmText, mapText });
    assert.equal(result.decodeArtifactCount, 0, `${name} must not be touched by R7`);
    assert.equal(result.unprotected.length, expected, `${name} must still be RED`);
  }
});

test('checkDominance: no isa symbol in the map at all is NOT protected', () => {
  const lines = parseDisasmLines([
    '  0000000180027F83: C4 C2 71 46 C2     vpsravd     xmm0,xmm1,xmm10',
  ].join('\n'));
  const dom = checkDominance(lines, [], 0x180027e10, 0x180028010, 0x180027f83);
  assert.equal(dom.protected, false);
});

test('fixture: protected-own-code (real Fundstelle 2a pattern) -> ALLOWED_PROTECTED, zero unprotected', () => {
  const { disasmText, mapText } = loadFixture('protected-own-code');
  const result = evaluateModule({ moduleName: 'protected-own-code', disasmText, mapText });
  assert.equal(result.hitCount, 1);
  assert.equal(result.unprotected.length, 0);
  assert.equal(result.verdicts[0].verdict, 'ALLOWED_PROTECTED');
});

test('fixture: crt-allowed (real Fundstelle 1a pattern, no isa read in-function) -> ALLOWED_CRT via allowlist', () => {
  const { disasmText, mapText } = loadFixture('crt-allowed');
  const result = evaluateModule({ moduleName: 'crt-allowed', disasmText, mapText });
  assert.equal(result.hitCount, 1);
  assert.equal(result.unprotected.length, 0);
  assert.equal(result.verdicts[0].verdict, 'ALLOWED_CRT');
});

test('RED PROBE: unprotected-own-code MUST come out UNPROTECTED (review-k1-avx.md R4)', () => {
  const { disasmText, mapText } = loadFixture('unprotected-own-code');
  const result = evaluateModule({ moduleName: 'unprotected-own-code', disasmText, mapText });
  assert.equal(result.hitCount, 1);
  assert.equal(result.unprotected.length, 1, 'the red probe must never be silently allowed');
  assert.equal(result.verdicts[0].verdict, 'UNPROTECTED');
});

test('CLI: the script actually runs main() as a real subprocess and exits 1 on the red probe', () => {
  // Regression test for a real bug found running this exact guard on the
  // Windows box (lu-301/bau/waechter-windows.md): the old entry-point check
  // compared `import.meta.url` (a file:// URL, forward slashes) against
  // `'file://' + process.argv[1]` (a native path, backslashes on Windows),
  // never equal there, so main() silently never ran and `node
  // win-isa-guard.mjs check ...` exited 0 having checked nothing at all,
  // on every invocation. A plain function-level test that only imports the
  // module (as every other test in this file does) cannot catch that class
  // of bug, because import.meta.url never even enters the entry-point
  // branch when the file is merely imported, it has to actually be run as
  // node's entry script, hence a real subprocess here.
  const script = join(HERE, 'win-isa-guard.mjs');
  const result = spawnSync(process.execPath, [
    script,
    'check',
    '--module', 'red-probe',
    // The fixture is deliberately a handful of lines (N2's own parse-count
    // guard would otherwise trip on it too, for an unrelated reason); this
    // test is specifically about the entry-point/exit-code regression, not
    // about N2, so disable that guard explicitly rather than relying on it
    // happening to fail for the right reason anyway.
    '--min-lines', '0',
    '--disasm', join(FIXTURES, 'unprotected-own-code.disasm.txt'),
    '--map', join(FIXTURES, 'unprotected-own-code.map.txt'),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1, `expected exit 1 (unprotected hit), got ${result.status}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /UNPROTECTED/);
});

test('N2 (review-waechter-windows.md): evaluateModule reports lineCount so the CLI can fail closed on an unparsed disasm dump', () => {
  const disasmText = [
    '  0000000180000000: C5 F9 6E D8        vmovd       xmm3,eax',
    '  0000000180000010: 48 89 5C 24 08     mov         qword ptr [rsp+8],rbx',
  ].join('\n');
  const result = evaluateModule({ moduleName: 'tiny', disasmText, mapText: '' });
  assert.equal(result.lineCount, 2);
});

test('N2: the CLI FAILS a disasm dump with too few parsed lines by default, even with zero hits', () => {
  const script = join(HERE, 'win-isa-guard.mjs');
  const emptyDisasm = join(HERE, '__fixtures__', 'win-isa', '.tmp-empty.disasm.txt');
  const emptyMap = join(HERE, '__fixtures__', 'win-isa', '.tmp-empty.map.txt');
  writeFileSync(emptyDisasm, 'Dump of file: nothing the parser recognises, no address-anchored lines at all.\n');
  writeFileSync(emptyMap, ' Static symbols\n\n 0001:00000000  x  0000000180000000 f  a.obj\n');
  try {
    const result = spawnSync(process.execPath, [
      script, 'check', '--module', 'unparsed', '--disasm', emptyDisasm, '--map', emptyMap,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, `expected exit 1 (too few parsed lines), got ${result.status}. stdout:\n${result.stdout}`);
    assert.match(result.stderr, /only 0 disassembled instruction line\(s\)/);
  } finally {
    rmSync(emptyDisasm, { force: true });
    rmSync(emptyMap, { force: true });
  }
});

test('N2: --min-lines 0 lets a deliberately tiny fixture (the red probe) skip the parse-count check', () => {
  const script = join(HERE, 'win-isa-guard.mjs');
  const result = spawnSync(process.execPath, [
    script, 'check', '--module', 'red-probe', '--min-lines', '0',
    '--disasm', join(FIXTURES, 'unprotected-own-code.disasm.txt'),
    '--map', join(FIXTURES, 'unprotected-own-code.map.txt'),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1, 'still fails, but for the real reason (UNPROTECTED), not the line-count guard');
  assert.match(result.stdout, /UNPROTECTED/);
  assert.doesNotMatch(result.stderr, /disassembled instruction line/);
});

test('map-control: a module with VEX/EVEX hits but zero map symbols cannot resolve any owner', () => {
  const disasmText = '  0000000180000000: C5 F9 6E D8        vmovd       xmm3,eax';
  const result = evaluateModule({ moduleName: 'empty-map', disasmText, mapText: '' });
  assert.equal(result.symbolCount, 0);
  assert.equal(result.hitCount, 1);
  assert.equal(result.ownedHitCount, 0);
  assert.equal(result.unprotected.length, 1, 'an unresolved owner must fail closed, not pass silently');
  assert.equal(result.verdicts[0].verdict, 'UNKNOWN_OWNER');
});
