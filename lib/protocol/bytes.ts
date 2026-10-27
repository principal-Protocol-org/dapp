// Buffer-free hex encoding (browser code never touches the Node Buffer global).
export function bytesToHex(u8: Uint8Array): string {
  let out = ""
  for (const byte of u8) out += byte.toString(16).padStart(2, "0")
  return out
}
