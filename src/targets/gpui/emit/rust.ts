export function pad(level: number): string {
  return '    '.repeat(level)
}

export function str(value: string): string {
  let hashes = ''
  while (value.includes(`"${hashes}`)) hashes += '#'
  return `r${hashes}"${value}"${hashes}`
}

export function num(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${+value.toFixed(6)}`
}

export function hex(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')
}
