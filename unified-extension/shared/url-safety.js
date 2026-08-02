/**
 * Service Worker가 외부 문서를 가져올 때 사용하는 공통 URL 경계입니다.
 * 웹 검색 결과가 로컬 장치·공유기·클라우드 메타데이터 주소로 우회되는 것을 막고,
 * 직접 입력 주소와 브라우저가 도착한 최종 응답 주소에 같은 검사를 적용합니다.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.com"
]);

export function parsePublicHttpUrl(rawUrl, baseUrl) {
  let url;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
      isBlockedHostname(url.hostname)) {
    return null;
  }
  return url;
}

export function isPublicHttpUrl(rawUrl, baseUrl) {
  return Boolean(parsePublicHttpUrl(rawUrl, baseUrl));
}

export function assertPublicHttpUrl(rawUrl, baseUrl) {
  const url = parsePublicHttpUrl(rawUrl, baseUrl);
  if (!url) {
    throw new Error("공개 웹 주소만 분석할 수 있습니다.");
  }
  return url;
}

/**
 * 브라우저 Fetch는 manual redirect의 Location을 공개하지 않으므로 자동 이동을 사용하되,
 * 직접 입력 주소와 최종 응답 주소를 모두 검증하고 사설 주소의 응답 내용은 사용하지 않습니다.
 */
export async function fetchPublicHttp(rawUrl, init = {}) {
  const initial = assertPublicHttpUrl(rawUrl);
  const response = await fetch(initial.href, { ...init, redirect: "follow" });
  assertPublicHttpUrl(response.url || initial.href);
  return response;
}

function isBlockedHostname(rawHostname) {
  const hostname = String(rawHostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) ||
      hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
      hostname.endsWith(".internal")) {
    return true;
  }

  return isBlockedIpv4(hostname) || isBlockedIpv6(hostname);
}

function isBlockedIpv4(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return false;
  }
  const octets = hostname.split(".").map(Number);
  if (octets.some((value) => value < 0 || value > 255)) {
    return true;
  }
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19));
}

function isBlockedIpv6(hostname) {
  if (!hostname.includes(":")) {
    return false;
  }
  const compact = hostname.toLowerCase();
  if (compact === "::" || compact === "::1" ||
      /^f[cd]/.test(compact) || /^fe[89ab]/.test(compact)) {
    return true;
  }

  // URL이 IPv4-mapped IPv6를 16진수로 정규화하는 경우까지 막습니다.
  const mapped = compact.match(/^(?:::ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped && compact.includes("ffff")) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    const ipv4 = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    return isBlockedIpv4(ipv4);
  }
  return false;
}
