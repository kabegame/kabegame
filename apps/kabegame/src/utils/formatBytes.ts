function formatBytes(bytes: number, decimals: number = 2, options?: {
    delimiter?: string;
}): string {
   if(bytes == 0) return '0 B';
   const finalOptions = {
       delimiter: ' ',
       ...options,
   };
   var k = 1024,
       dm = decimals || 2,
       sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
       i = Math.floor(Math.log(bytes) / Math.log(k));
   return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + (finalOptions.delimiter) + sizes[i];
}