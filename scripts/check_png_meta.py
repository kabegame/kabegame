import struct, zlib

def read_png_chunks(path):
    with open(path, 'rb') as f:
        sig = f.read(8)
        if sig != b'\x89PNG\r\n\x1a\n':
            print('Not a PNG file')
            return []
        chunks = []
        while True:
            length_bytes = f.read(4)
            if len(length_bytes) < 4:
                break
            length = struct.unpack('>I', length_bytes)[0]
            chunk_type = f.read(4).decode('ascii', errors='replace')
            data = f.read(length)
            crc = f.read(4)
            chunks.append((chunk_type, data))
    return chunks

path = r'E:\Pictures\Kabegame\137022736_p0-0c36fc45.png'
chunks = read_png_chunks(path)
found_any = False
for ctype, data in chunks:
    if ctype in ('tEXt', 'zTXt', 'iTXt'):
        found_any = True
        print(f'Chunk type: {ctype}')
        if ctype == 'tEXt':
            parts = data.split(b'\x00', 1)
            key = parts[0].decode('latin-1')
            val = parts[1].decode('latin-1') if len(parts) > 1 else ''
            print(f'  Key: {key}')
            print(f'  Value (first 300 chars): {val[:300]}')
        elif ctype == 'zTXt':
            parts = data.split(b'\x00', 2)
            key = parts[0].decode('latin-1')
            print(f'  Key: {key}')
            if len(parts) > 2:
                try:
                    val = zlib.decompress(parts[2]).decode('utf-8', errors='replace')
                    print(f'  Value (first 300 chars): {val[:300]}')
                except Exception as e:
                    print(f'  Decompress error: {e}')
        elif ctype == 'iTXt':
            print(f'  Raw (first 300 bytes): {data[:300]}')
        print()

if not found_any:
    print('No text metadata chunks found (tEXt/zTXt/iTXt)')
    print('Available chunk types:', [c for c, _ in chunks])
