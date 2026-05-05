/**
 * Pagination utility
 *
 * Usage:
 *   const { page, limit, skip } = parsePagination(req.query);
 *   const { data, pagination } = await paginateQuery(MyModel, filter, { page, limit, skip, sort });
 *   res.json({ items: data, pagination });
 */

/**
 * Parse and clamp pagination params from req.query.
 *
 * @param {object} query        - req.query (or any object with page/limit keys)
 * @param {object} [options]
 * @param {number} [options.defaultLimit=50]   - default page size when limit is omitted
 * @param {number} [options.maxLimit=200]      - hard cap on page size
 * @returns {{ page: number, limit: number, skip: number }}
 */
export function parsePagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

/**
 * Run a paginated Mongoose query in parallel with a count.
 *
 * @param {import('mongoose').Model} model    - Mongoose model
 * @param {object} filter                     - Mongoose filter object
 * @param {object} options
 * @param {number} options.page               - current page (from parsePagination)
 * @param {number} options.limit              - page size (from parsePagination)
 * @param {number} options.skip               - skip count (from parsePagination)
 * @param {object} [options.sort={ _id: -1 }] - Mongoose sort object
 * @param {string} [options.select]           - field projection string
 * @param {boolean} [options.lean=true]       - whether to call .lean()
 * @returns {Promise<{ data: any[], pagination: { page, limit, total, totalPages } }>}
 */
export async function paginateQuery(model, filter, { page, limit, skip, sort = { _id: -1 }, select, lean = true }) {
  let q = model.find(filter).sort(sort).skip(skip).limit(limit);
  if (select) q = q.select(select);
  if (lean) q = q.lean();

  const [data, total] = await Promise.all([q, model.countDocuments(filter)]);
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}
