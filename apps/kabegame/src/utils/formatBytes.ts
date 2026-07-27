export function formatBytes(bytes: number, decimals: number = 2, options?: {
  delimiter?: string;
}): string {
  if (bytes <= 0) return "0 B";
  const finalOptions = {
    delimiter: " ",
    ...options,
  };
  const unit = 1024;
  const precision = decimals || 2;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const index = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(unit)));
  return `${parseFloat((bytes / Math.pow(unit, index)).toFixed(precision))}${finalOptions.delimiter}${sizes[index]}`;
}
