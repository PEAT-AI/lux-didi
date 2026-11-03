import { BlockList, isIP } from 'node:net';

/** Credentials are always refused; private hosts are allowed only before outside text. */
const PRIVATE_ADDRESSES = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) PRIVATE_ADDRESSES.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) PRIVATE_ADDRESSES.addSubnet(address, prefix, 'ipv6');

export function webDestinationAllowed(target: string, outsideText: boolean): boolean {
  try {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return false;
    if (!outsideText) return true;
    const host = url.hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '');
    if (!host || /(?:^|\.)(?:localhost|local|internal|home|lan)$/u.test(host)) return false;
    const ip = isIP(host);
    if (ip) return !PRIVATE_ADDRESSES.check(host, ip === 4 ? 'ipv4' : 'ipv6');
    return true;
  } catch { return false; }
}

