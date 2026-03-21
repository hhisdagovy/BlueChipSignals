const SUPPORTED_TICKERS = ['SPY', 'TSLA', 'META', 'AAPL', 'NVDA', 'AMZN'] as const

export const ENTITLEMENT_STATUS = {
  ACTIVE: 'active',
  PENDING_CHANNEL_SELECTION: 'pending_channel_selection',
  PROVISIONING_FAILED: 'provisioning_failed'
} as const

export const PRODUCT_KEYS = {
  SINGLE_CHANNEL: 'single_channel',
  FULL_BUNDLE: 'full_bundle'
} as const

const DEFAULT_BUNDLE_TICKERS = [...SUPPORTED_TICKERS]

export function normalizeEmail(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

export function normalizeTicker(value: unknown) {
  const normalized = String(value ?? '').trim().toUpperCase()
  return SUPPORTED_TICKERS.includes(normalized as (typeof SUPPORTED_TICKERS)[number])
    ? normalized
    : ''
}

export function deriveProductKey({
  metadata = {},
  lineItems = []
}: {
  metadata?: Record<string, unknown>
  lineItems?: Array<Record<string, any>>
}) {
  const metadataProduct = String(
    metadata.product_key ?? metadata.productKey ?? metadata.plan ?? ''
  ).trim().toLowerCase()

  if (
    metadataProduct === PRODUCT_KEYS.SINGLE_CHANNEL
    || metadataProduct === PRODUCT_KEYS.FULL_BUNDLE
  ) {
    return metadataProduct
  }

  for (const item of lineItems) {
    const priceMetadata = item?.price?.metadata ?? {}
    const productMetadata = item?.price?.product?.metadata ?? {}
    const candidate = String(
      productMetadata.product_key
      ?? priceMetadata.product_key
      ?? productMetadata.plan
      ?? priceMetadata.plan
      ?? ''
    ).trim().toLowerCase()

    if (
      candidate === PRODUCT_KEYS.SINGLE_CHANNEL
      || candidate === PRODUCT_KEYS.FULL_BUNDLE
    ) {
      return candidate
    }
  }

  return ''
}

export function mapEntitlements({
  productKey,
  ticker
}: {
  productKey: string
  ticker?: unknown
}) {
  if (productKey === PRODUCT_KEYS.FULL_BUNDLE) {
    return {
      plan: 'bundle',
      allowedTicker: '',
      allowedTickers: DEFAULT_BUNDLE_TICKERS,
      fulfillmentStatus: ENTITLEMENT_STATUS.ACTIVE,
      pendingChannelSelection: false
    }
  }

  if (productKey === PRODUCT_KEYS.SINGLE_CHANNEL) {
    const normalizedTicker = normalizeTicker(ticker)
    return {
      plan: 'single',
      allowedTicker: normalizedTicker,
      allowedTickers: normalizedTicker ? [normalizedTicker] : [],
      fulfillmentStatus: normalizedTicker
        ? ENTITLEMENT_STATUS.ACTIVE
        : ENTITLEMENT_STATUS.PENDING_CHANNEL_SELECTION,
      pendingChannelSelection: !normalizedTicker
    }
  }

  throw new Error(`Unsupported product key: ${productKey}`)
}

