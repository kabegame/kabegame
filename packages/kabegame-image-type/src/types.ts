export type ImageFormat = "webp" | "avif" | "heic"

export interface ImageSupportResult {
  webp: boolean
  avif: boolean
  heic: boolean
}
