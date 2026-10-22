import { ssrfIpClassifier } from './ssrf-ip-classifier'

const ALLOWED_OUTBOUND_PROTOCOLS = new Set(['http:', 'https:'])
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const MAX_OUTBOUND_URL_LENGTH = 300
const MAX_HTTP_HEADER_NAME_LENGTH = 128
const IPV6_BRACKETS_PATTERN = /^\[([^\]]+)\]$/
// Names that always denote the local host. Unlike a private IP literal these can never be
// legitimately reached from a server pod, so they stay blocked even when an allow-list exists.
const LOCAL_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback'])

function parseUrlOrNull(rawUrl: string): URL | null {
    try {
        return new URL(rawUrl)
    }
    catch {
        return null
    }
}

function unwrapIpv6Hostname(hostname: string): string {
    const match = IPV6_BRACKETS_PATTERN.exec(hostname)
    return match ? match[1] : hostname
}

function normalizeHostname(hostname: string): string {
    return unwrapIpv6Hostname(hostname).trim().toLowerCase()
}

function isValidHttpHeaderName(name: string): boolean {
    return HTTP_HEADER_NAME_PATTERN.test(name)
}

// Shape validation only: it proves the value is a well-formed http(s) URL that cannot smuggle
// credentials or a second authority, but deliberately does NOT reject private hosts. Self-hosted
// OpenAI-compatible gateways legitimately live on a private address, so the egress decision is
// made at request time by `isBlockedOutboundHost`, which honours the allow-list.
function classifyOutboundUrl({ url }: OutboundUrlClassificationParams): OutboundUrlClassification {
    if (url.length === 0 || url.length > MAX_OUTBOUND_URL_LENGTH) {
        return { ok: false, reason: 'unparseable' }
    }
    const parsed = parseUrlOrNull(url)
    if (parsed === null) {
        return { ok: false, reason: 'unparseable' }
    }
    if (!ALLOWED_OUTBOUND_PROTOCOLS.has(parsed.protocol)) {
        return { ok: false, reason: 'protocol' }
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
        return { ok: false, reason: 'credentials' }
    }
    if (normalizeHostname(parsed.hostname).length === 0) {
        return { ok: false, reason: 'hostname' }
    }
    return { ok: true }
}

function isBlockedOutboundHost({ hostname, allowList }: IsBlockedOutboundHostParams): boolean {
    const host = normalizeHostname(hostname)
    if (host.length === 0) {
        return true
    }
    if (allowList.some((entry) => normalizeHostname(entry) === host)) {
        return false
    }
    if (LOCAL_HOSTNAMES.has(host)) {
        return true
    }
    // A DNS name is only resolved by the egress agent at connect time, so it is not judged here.
    if (!ssrfIpClassifier.isIpLiteral(host)) {
        return false
    }
    return ssrfIpClassifier.isBlockedIp({ ip: host, allowList })
}

export const outboundUrlPolicy = {
    MAX_HTTP_HEADER_NAME_LENGTH,
    MAX_OUTBOUND_URL_LENGTH,
    classifyOutboundUrl,
    isBlockedOutboundHost,
    isValidHttpHeaderName,
}

export type OutboundUrlClassification =
    | { ok: true }
    | { ok: false, reason: 'unparseable' | 'protocol' | 'credentials' | 'hostname' }

export type OutboundUrlClassificationParams = {
    url: string
}

export type IsBlockedOutboundHostParams = {
    hostname: string
    allowList: string[]
}
