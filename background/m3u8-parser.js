// M3U8 清单解析器：支持多码率主清单、AES-128 密钥、fMP4 初始化段（EXT-X-MAP）识别

// 相对地址解析为绝对 URL
export function resolveUrl(baseUrl, relative) {
  try {
    return new URL(relative, baseUrl).href;
  } catch {
    return relative;
  }
}

// 解析属性行（如 #EXT-X-KEY:METHOD=AES-128,URI="key.key",IV=0xabc）为对象
export function parseAttributes(attrText) {
  const attrs = {};
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = regex.exec(attrText)) !== null) {
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    attrs[match[1]] = value;
  }
  return attrs;
}

// IV 十六进制字符串（"0x..."）转 16 字节数组；未显式指定时按 HLS 规范用媒体序号（大端）
export function ivToBytes(ivHex, mediaSequence) {
  const bytes = new Uint8Array(16);
  if (ivHex) {
    const padded = ivHex.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    return bytes;
  }
  new DataView(bytes.buffer).setUint32(12, mediaSequence >>> 0);
  return bytes;
}

// 解析 m3u8 文本；baseUrl 用于解析片段/密钥的相对路径
export function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];   // 多码率子清单
  const segments = [];   // 媒体分片
  let isLive = true;
  let mediaSequence = 0;
  let currentKey = null; // 当前生效的解密密钥（可中途更换）
  let mapUri = null;     // fMP4 初始化段
  let pendingDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      const next = (lines[i + 1] || '').trim();
      if (next && !next.startsWith('#')) {
        variants.push({
          url: resolveUrl(baseUrl, next),
          bandwidth: parseInt(attrs.BANDWIDTH, 10) || 0,
          resolution: attrs.RESOLUTION || ''
        });
      }
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      currentKey = attrs.METHOD === 'NONE' ? null : {
        method: attrs.METHOD,
        uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
        iv: attrs.IV || null,
        keyFormat: attrs.KEYFORMAT || 'identity'
      };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        mapUri = { url: resolveUrl(baseUrl, attrs.URI), key: currentKey };
      }
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
    } else if (line === '#EXT-X-ENDLIST') {
      isLive = false;
    } else if (!line.startsWith('#')) {
      segments.push({
        url: resolveUrl(baseUrl, line),
        duration: pendingDuration,
        key: currentKey ? { ...currentKey } : null
      });
      pendingDuration = 0;
    }
  }

  return { isMaster: variants.length > 0, variants, isLive, mediaSequence, segments, mapUri };
}

// 推断合并输出容器：存在初始化段或多数分片为 m4s/mp4 → fMP4（合并即 mp4）；否则为 ts
export function inferContainer(parsed) {
  if (parsed.mapUri) return 'mp4';
  const fmp4Count = parsed.segments.filter((s) => /\.(m4s|mp4)(\?|#|$)/i.test(s.url)).length;
  return fmp4Count > parsed.segments.length / 2 ? 'mp4' : 'ts';
}
