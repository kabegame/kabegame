export type ImageFormat = "webp" | "avif" | "heic" | "svg"

export interface ImageSupportResult {
  webp: boolean
  avif: boolean
  heic: boolean
  svg: boolean
}
