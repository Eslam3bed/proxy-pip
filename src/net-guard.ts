import dns from 'node:dns/promises';
import net from 'node:net';

export function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
  }
  if (ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
}

export async function resolveAndCheckSSRF(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) throw new Error('SSRF');
    return;
  }
  const { address } = await dns.lookup(hostname);
  if (isPrivateIP(address)) throw new Error('SSRF');
}
