/**
 * Best Offers routes — eBay Trading API
 *
 * GET  /api/ebay/best-offers            — GetBestOffers
 * POST /api/ebay/best-offers/respond    — RespondToBestOffer
 *
 * Mounted at /api/ebay in server/src/index.js so the URL prefix
 * remains identical to what the frontend expects.
 */

import express from 'express';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { requireAuth } from '../middleware/auth.js';
import Seller from '../models/Seller.js';
import { ensureValidToken } from './ebay.js';

const router = express.Router();

const EBAY_TRADING_URL = 'https://api.ebay.com/ws/api.dll';

// eBay site IDs mapped from marketplace slugs stored on the Seller document
const MARKETPLACE_SITEID = {
  EBAY_US: '0',
  EBAY_GB: '3',
  EBAY_DE: '77',
  EBAY_AU: '15',
  EBAY_CA: '2',
  EBAY_FR: '71',
  EBAY_IT: '101',
  EBAY_ES: '186',
};
const getSiteId = (seller) => MARKETPLACE_SITEID[seller.ebayMarketplaces?.[0]] ?? '0';

const tradingHeaders = (callName, siteId = '0') => ({
  'X-EBAY-API-SITEID': siteId,
  'X-EBAY-API-COMPATIBILITY-LEVEL': '1453',
  'X-EBAY-API-CALL-NAME': callName,
  'Content-Type': 'text/xml',
});

// ─── Sanitise values injected into XML ────────────────────────────────────────
const escapeXml = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// ─── Normalise single-item eBay responses to arrays ───────────────────────────
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ─── Fetch SKU for a single item via GetItem ─────────────────────────────────
// GetItem always returns Item.SKU (the seller's custom label / SKU) when set.
async function fetchItemSku(token, siteId, itemId) {
  try {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${escapeXml(itemId)}</ItemID>
  <IncludeItemSpecifics>false</IncludeItemSpecifics>
</GetItemRequest>`;
    const resp = await axios.post(EBAY_TRADING_URL, xml, {
      headers: tradingHeaders('GetItem', siteId),
    });
    const parsed = await parseStringPromise(resp.data, { explicitArray: false });
    return parsed?.GetItemResponse?.Item?.SKU ?? '';
  } catch {
    return '';
  }
}

// ─── Normalise one eBay BestOffer node into a clean object ───────────────────
// Works for both ItemBestOffersArray.ItemBestOffers.Item (no ItemID call) and
// the top-level Item returned when an ItemID is supplied.
function parseOffer(item, offer) {
  // BuyItNowPrice is the listing price in both response shapes
  const listPrice = item.BuyItNowPrice?._ ?? item.BuyItNowPrice ?? null;
  const listCurrency = item.BuyItNowPrice?.['$']?.currencyID ?? item.Currency ?? 'USD';

  return {
    sku: item.SKU ?? '',
    bestOfferId: offer.BestOfferID,
    itemId: item.ItemID,
    title: item.Title ?? `Item ${item.ItemID}`,
    listingPrice: listPrice,
    listingCurrency: listCurrency,
    listingEndTime: item.ListingDetails?.EndTime ?? null,
    offerPrice: offer.Price?._ ?? offer.Price ?? null,
    offerCurrency: offer.Price?.['$']?.currencyID ?? 'USD',
    quantity: offer.Quantity ?? 1,
    status: offer.Status,
    buyerMessage: offer.BuyerMessage ?? '',
    sellerMessage: offer.SellerMessage ?? '',
    expirationTime: offer.ExpirationTime ?? null,
    offerType: offer.BestOfferCodeType ?? 'BuyerBestOffer',
    buyerId: offer.Buyer?.UserID ?? '',
    buyerFeedbackScore: offer.Buyer?.FeedbackScore ?? 0,
    buyerEmail: offer.Buyer?.Email ?? '',
  };
}

// =============================================================================
// GET /best-offers
// Query: sellerId, status (Active|Accepted|Declined|Expired|All)
//
// Per eBay Trading API docs (v1453):
//   - Omit both ItemID and BestOfferID → eBay returns ALL active seller offers
//     in ItemBestOffersArray (up to 10,000 IDs for sellers).
//   - Supplying an ItemID → returns BestOfferArray for that specific listing,
//     and the BestOfferStatus filter is honoured (including "All").
//   - Note: when no ItemID is given, the status filter is effectively always
//     "Active" regardless of what is passed (eBay API limitation).
// =============================================================================
router.get('/best-offers', requireAuth, async (req, res) => {
  try {
    const { sellerId, status = 'Active' } = req.query;

    if (!sellerId) return res.status(400).json({ error: 'Missing sellerId' });

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);
    const siteId = getSiteId(seller);

    // When no ItemID is supplied eBay defaults to Active — the "All" filter
    // only works together with an ItemID per the docs.
    // We omit <BestOfferStatus> entirely so eBay uses its default (Active),
    // which is the same behaviour the seller sees in Seller Hub.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetBestOffersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>
</GetBestOffersRequest>`;

    const response = await axios.post(EBAY_TRADING_URL, xml, {
      headers: tradingHeaders('GetBestOffers', siteId),
    });

    const parsed = await parseStringPromise(response.data, { explicitArray: false });
    const root = parsed?.GetBestOffersResponse;

    if (root?.Ack === 'Failure') {
      const errs = toArray(root?.Errors);
      return res.status(400).json({
        error: 'eBay API error',
        details: errs.map((e) => e.LongMessage).join('; '),
      });
    }

    // eBay returns results in ItemBestOffersArray when no ItemID is given.
    // Each entry groups one item with all its offers.
    const offers = [];
    for (const entry of toArray(root?.ItemBestOffersArray?.ItemBestOffers)) {
      const item = entry?.Item ?? {};
      for (const offer of toArray(entry?.BestOfferArray?.BestOffer)) {
        offers.push(parseOffer(item, offer));
      }
    }

    // ── Enrich with SKU via GetItem (parallel, one call per unique item ID) ──
    // GetBestOffers does not return Item.SKU in its item stub; GetItem does.
    if (offers.length > 0) {
      const uniqueItemIds = [...new Set(offers.map(o => o.itemId).filter(Boolean))];
      const skuResults = await Promise.all(
        uniqueItemIds.map(id => fetchItemSku(token, siteId, id).then(sku => [id, sku]))
      );
      const skuMap = Object.fromEntries(skuResults);
      for (const offer of offers) {
        if (skuMap[offer.itemId]) offer.sku = skuMap[offer.itemId];
      }
    }

    console.log(`[BestOffers] fetched ${offers.length} offer(s) via single GetBestOffers call`);

    const pagination = root?.PaginationResult ?? {};
    return res.json({
      success: true,
      offers,
      totalEntries: parseInt(pagination.TotalNumberOfEntries) || offers.length,
      totalPages: parseInt(pagination.TotalNumberOfPages) || 1,
      currentPage: 1,
    });
  } catch (err) {
    console.error('[BestOffers] error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch best offers', details: err.message });
  }
});

// =============================================================================
// POST /best-offers/respond
// Body: { sellerId, itemId, bestOfferId, action, counterPrice?, counterQuantity?, sellerResponse? }
// action: 'Accept' | 'Decline' | 'Counter'
// =============================================================================
router.post('/best-offers/respond', requireAuth, async (req, res) => {
  try {
    const {
      sellerId,
      itemId,
      bestOfferId,
      action,
      counterPrice,
      counterQuantity,
      sellerResponse,
    } = req.body;

    if (!sellerId || !itemId || !bestOfferId || !action) {
      return res.status(400).json({
        error: 'Missing required fields: sellerId, itemId, bestOfferId, action',
      });
    }

    const VALID_ACTIONS = ['Accept', 'Decline', 'Counter'];
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({
        error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}`,
      });
    }

    if (action === 'Counter' && !counterPrice) {
      return res.status(400).json({ error: 'counterPrice is required when action is Counter' });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);
    const siteId = getSiteId(seller);

    const counterBlock =
      action === 'Counter'
        ? `<CounterOfferPrice currencyID="USD">${parseFloat(counterPrice).toFixed(2)}</CounterOfferPrice>
         <CounterOfferQuantity>${parseInt(counterQuantity) || 1}</CounterOfferQuantity>`
        : '';

    const sellerResponseBlock = sellerResponse
      ? `<SellerResponse>${escapeXml(sellerResponse)}</SellerResponse>`
      : '';

    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<RespondToBestOfferRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <ItemID>${escapeXml(itemId)}</ItemID>
  <BestOfferID>${escapeXml(bestOfferId)}</BestOfferID>
  <Action>${escapeXml(action)}</Action>
  ${counterBlock}
  ${sellerResponseBlock}
</RespondToBestOfferRequest>`;

    const response = await axios.post(EBAY_TRADING_URL, xmlRequest, {
      headers: tradingHeaders('RespondToBestOffer', siteId),
    });

    const parsed = await parseStringPromise(response.data, { explicitArray: false });
    const root = parsed.RespondToBestOfferResponse;
    const ack = root?.Ack;

    if (ack === 'Failure') {
      const errors = toArray(root?.Errors);
      return res.status(400).json({
        error: 'eBay API error',
        details: errors.map((e) => e.LongMessage).join('; '),
      });
    }

    return res.json({
      success: true,
      ack,
      message: `Offer ${action.toLowerCase()}ed successfully`,
    });
  } catch (err) {
    console.error('[BestOffers] RespondToBestOffer error:', err.message);
    return res.status(500).json({ error: 'Failed to respond to offer', details: err.message });
  }
});

// =============================================================================
// GET /eligible-offers
// Uses eBay Negotiation REST API — finds listings eligible for seller-initiated
// offers to interested buyers (watchers/viewers), matching the "Eligible to
// send offers" count shown in eBay Seller Hub.
// Query: sellerId
// =============================================================================
router.get('/eligible-offers', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.query;
    if (!sellerId) return res.status(400).json({ error: 'Missing sellerId' });

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);
    const marketplaceId = seller.ebayMarketplaces?.[0] ?? 'EBAY_US';

    const response = await axios.get(
      'https://api.ebay.com/sell/negotiation/v1/find_eligible_items',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
          'Content-Type': 'application/json',
        },
        params: { limit: 200, offset: 0 },
      }
    );

    const items = (response.data.eligibleItems ?? []).map((i) => ({
      listingId: i.listingId,
      itemId: i.itemId,
      title: i.listingTitle ?? i.listingId,
      listingStatus: i.listingStatus ?? 'ACTIVE',
      minimumOfferPrice: i.minimumOfferPrice?.value ?? null,
      minimumOfferCurrency: i.minimumOfferPrice?.currency ?? 'USD',
      interestedBuyers: i.eligibleCounterPartiesCount ?? 0,
    }));

    return res.json({ success: true, items, total: response.data.total ?? items.length });
  } catch (err) {
    const ebayError = err.response?.data?.errors?.[0]?.message ?? err.message;
    console.error('[BestOffers] find_eligible_items error:', err.response?.data ?? err.message);
    return res.status(err.response?.status ?? 500).json({ error: 'Failed to fetch eligible items', details: ebayError });
  }
});

// =============================================================================
// POST /eligible-offers/send
// Uses eBay Negotiation REST API — sends a seller-initiated offer to all
// interested buyers on a listing.
// Body: { sellerId, listingId, price, currency?, quantity?, message?, allowCounter? }
// =============================================================================
router.post('/eligible-offers/send', requireAuth, async (req, res) => {
  try {
    const { sellerId, listingId, price, currency, quantity, message, allowCounter = true } = req.body;

    if (!sellerId || !listingId || !price) {
      return res.status(400).json({ error: 'Missing required fields: sellerId, listingId, price' });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);
    const marketplaceId = seller.ebayMarketplaces?.[0] ?? 'EBAY_US';

    await axios.post(
      'https://api.ebay.com/sell/negotiation/v1/send_offer_to_interested_buyers',
      {
        allowCounterOffer: Boolean(allowCounter),
        message: message || undefined,
        offeredItems: [{
          listingId,
          price: { currency: currency || 'USD', value: parseFloat(price).toFixed(2) },
          quantity: parseInt(quantity) || 1,
        }],
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
          'Content-Type': 'application/json',
        },
      }
    );

    return res.json({ success: true, message: 'Offer sent to interested buyers' });
  } catch (err) {
    const ebayError = err.response?.data?.errors?.[0]?.message ?? err.message;
    console.error('[BestOffers] send_offer_to_interested_buyers error:', err.response?.data ?? err.message);
    return res.status(err.response?.status ?? 500).json({ error: 'Failed to send offer', details: ebayError });
  }
});

export default router;
