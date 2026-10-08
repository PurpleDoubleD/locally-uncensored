/** Types for the plain-node module. The script runs in CI without a build
 *  step, so the implementation stays .mjs and the types live here. */

export declare const BUNDLE_MARKER: string
export declare const VARIANTS: { nsis: string; msi: string }

export declare function patchBundleType(binary: Buffer, variant: string): Buffer
export declare function bundleTypeOf(binary: Buffer): 'nsis' | 'msi' | null
export declare function peCertificateTableSize(binary: Buffer): number
export declare function zipOfOneFile(name: string, data: Buffer): Buffer
export declare function releaseAssetName(fileName: string): string

export interface UpdaterPlatform {
  signature: string
  url: string
}
export interface LatestJson {
  version: string
  notes?: string
  pub_date?: string
  platforms?: Record<string, UpdaterPlatform>
}

export declare function windowsPlatforms(
  files: string[],
  signatureOf: (file: string) => string,
  downloadBaseUrl: string,
): Record<string, UpdaterPlatform>
export declare function mergeLatestJson(
  existing: LatestJson | null,
  platforms: Record<string, UpdaterPlatform>,
  fallback: { version: string; notes: string; pubDate: string },
): LatestJson
