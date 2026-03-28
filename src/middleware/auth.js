import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// Page registry: maps pageId -> defaultRoles (backward compat)
// This is the server-side source of truth for which roles have default access to each page
export const PAGE_DEFAULT_ROLES = {
  // Order Fulfilment
  'OrdersDashboard': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'OrderAnalytics': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'Fulfillment': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'AwaitingShipment': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'AwaitingSheet': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'AmazonArrivals': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'FulfillmentNotes': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],

  // Compatibility
  'CompatibilityDashboard': ['superadmin', 'compatibilityadmin', 'compatibilityeditor'],
  'CompatibilityTasks': ['superadmin', 'compatibilityadmin'],
  'CompatibilityProgress': ['superadmin', 'compatibilityadmin'],
  'AiFitmentUsage': ['superadmin', 'compatibilityadmin'],
  'ListingStats': ['superadmin', 'compatibilityadmin'],
  'CompatibilityBatchHistory': ['superadmin', 'compatibilityadmin', 'compatibilityeditor'],
  'EditListings': ['superadmin', 'compatibilityadmin', 'compatibilityeditor'],
  'CompatibilityEditor': ['superadmin', 'compatibilityeditor'],
  'AddCompatibilityEditor': ['superadmin', 'compatibilityadmin'],

  // Listing & Research
  'ManageTemplates': ['superadmin'],
  'ListingsDatabase': ['superadmin'],
  'SelectSeller': ['superadmin', 'lister', 'advancelister', 'trainee'],
  'SellerTemplates': ['superadmin', 'lister', 'advancelister', 'trainee'],
  'TemplateListings': ['superadmin', 'lister', 'advancelister', 'trainee'],
  'ListingDirectory': ['superadmin', 'lister', 'advancelister', 'trainee'],
  'TemplateDirectory': ['superadmin', 'lister', 'advancelister', 'trainee'],
  'TemplateListingAnalytics': ['superadmin', 'lister', 'advancelister', 'trainee'],
  'AsinDirectory': ['superadmin', 'productadmin'],
  'AsinLists': ['superadmin', 'productadmin'],
  'FeedUpload': ['superadmin', 'listingadmin', 'lister'],
  'FeedUploadStats': ['superadmin', 'listingadmin'],
  'CsvStorage': ['superadmin', 'listingadmin', 'lister'],
  'ProductResearch': ['superadmin', 'productadmin'],

  // Finance & Cash Flow
  'Payoneer': ['superadmin'],
  'BankAccounts': ['superadmin'],
  'Transactions': ['superadmin'],
  'ExtraExpenses': ['superadmin'],
  'CreditCardNames': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'Salary': ['superadmin'],
  'AllOrdersSheet': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'SellerAnalytics': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],

  // Compliance & Support
  'Disputes': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'AccountHealth': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'BuyerMessages': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'ConversationManagement': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'AmazonAccounts': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'CreditCards': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],
  'AffiliateOrders': ['superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'],

  // eBay Parameters
  'SellingPrivileges': ['superadmin', 'listingadmin'],
  'EbayApiUsage': ['superadmin', 'listingadmin'],
  'SellerFunds': ['superadmin', 'listingadmin'],

  // HR & Management
  'IdeasAndIssues': ['superadmin', 'hradmin', 'operationhead', 'listingadmin'],
  'TeamChat': ['superadmin', 'hradmin', 'operationhead', 'listingadmin'],
  'LeaveAdmin': ['superadmin', 'hradmin'],
  'EmployeeManagement': ['superadmin', 'hradmin'],
  'AddUser': ['superadmin', 'listingadmin', 'hradmin', 'operationhead'],
  'UserSellerAssignments': ['superadmin', 'hradmin', 'hr'],
  'ViewAllMessages': ['superadmin'],
  'Attendance': ['superadmin'],
  'PageAccessManagement': ['superadmin'],
  'UserPasswordManagement': ['superadmin'],

  // Others (superadmin only by default)
  'ManageCategories': ['superadmin', 'productadmin'],
  'ManagePlatforms': ['superadmin', 'listingadmin'],
  'ManageStores': ['superadmin', 'listingadmin'],
  'ProductTable': ['superadmin', 'listingadmin'],
  'TaskList': ['superadmin', 'listingadmin'],
  'Assignments': ['superadmin', 'listingadmin'],
  'ListingsSummary': ['superadmin', 'listingadmin'],
  'ListingSheet': ['superadmin', 'listingadmin'],
  'StoreWiseTasks': ['superadmin', 'listingadmin'],
  'StoreDailyTasks': ['superadmin', 'listingadmin'],
  'ListerInfo': ['superadmin', 'listingadmin'],
  'RangeAnalyzer': ['superadmin', 'listingadmin'],
  'AmazonLookup': ['superadmin'],
  'ProductUmbrellas': ['superadmin'],
  'AsinStorage': ['superadmin', 'productadmin'],
  'ColumnCreator': ['superadmin', 'productadmin'],
  'ManageRanges': ['superadmin', 'productadmin'],
  'UserCredentials': ['superadmin'],
  'UserPerformance': ['superadmin'],
  'EmployeeDetails': ['superadmin', 'hradmin', 'operationhead'],

  // Shared pages (accessible to all authenticated users)
  'AboutMe': ['_all_except_superadmin'],
  'MyLeaves': ['_all_except_superadmin'],
  'InternalMessages': ['_all'],
  'Ideas': ['_all'],
};

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  // Fallback: check query param for token (e.g., for eBay OAuth redirects)
  if (!token && req.query.token) {
    token = req.query.token;
  }
  
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    
    // Validate token version against database (security: invalidate old tokens on password change)
    const user = await User.findById(payload.userId).select('tokenVersion').lean();
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const userTokenVersion = user.tokenVersion || 1;
    const payloadTokenVersion = payload.tokenVersion || 1;
    
    if (payloadTokenVersion !== userTokenVersion) {
      return res.status(401).json({ error: 'Token expired. Please login again.' });
    }
    
    req.user = payload; // { userId, role, tokenVersion }
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Legacy role check — kept for non-page-specific routes
export function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

/**
 * New page-based access control middleware.
 * Replaces requireRole() for all admin-managed page routes.
 *
 * @param {string|string[]} pageId - Single page identifier or array of page IDs (user needs access to ANY one)
 * @param {string[]} [defaultRoles] - Override default roles (optional, falls back to PAGE_DEFAULT_ROLES)
 */
export function requirePageAccess(pageId, defaultRoles) {
  // Normalize to array for consistent handling
  const pageIds = Array.isArray(pageId) ? pageId : [pageId];
  
  // Collect fallback roles from all pages (if defaultRoles not provided)
  let fallbackRoles = defaultRoles;
  if (!fallbackRoles) {
    const allRoles = new Set();
    pageIds.forEach(id => {
      const roles = PAGE_DEFAULT_ROLES[id] || [];
      roles.forEach(role => allRoles.add(role));
    });
    fallbackRoles = Array.from(allRoles);
  }

  return async function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Superadmin always has access
    if (req.user.role === 'superadmin') {
      return next();
    }

    try {
      // Fetch user's permission settings from DB
      const user = await User.findById(req.user.userId).select('pagePermissions useCustomPermissions role').lean();
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      if (user.useCustomPermissions) {
        // Custom permissions mode: check if user has access to ANY of the requested pages
        const hasAccess = user.pagePermissions && pageIds.some(id => user.pagePermissions.includes(id));
        if (hasAccess) {
          return next();
        }
        return res.status(403).json({ error: 'Forbidden: You do not have access to this page' });
      } else {
        // Default mode: check role-based defaults
        // Handle special role groups
        if (fallbackRoles.includes('_all')) {
          return next();
        }
        if (fallbackRoles.includes('_all_except_superadmin')) {
          return next(); // Already not superadmin (checked above)
        }
        if (fallbackRoles.includes(user.role)) {
          return next();
        }
        return res.status(403).json({ error: 'Forbidden' });
      }
    } catch (err) {
      console.error('requirePageAccess error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}
