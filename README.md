# Grow Cursor — Backend

> RESTful API server powering the Grow e-commerce management platform.

## Overview

Grow Cursor Backend is a Node.js and Express API server that serves as the backbone for the Grow e-commerce management platform. It handles wide-ranging operations including user authentication, scalable role-based access control, and automated e-commerce workflows like eBay listing management, Amazon product lookup, and order processing. The backend is designed with a scalable architecture to reliably support expansive internal business processes, featuring AI-powered automations and high-performance data pipelines.

## Tech Stack

- **Runtime & Framework:** Node.js, Express.js
- **Database:** MongoDB (via Mongoose ODM)
- **Authentication & Security:** JWT, bcryptjs, Helmet, Rate Limiting
- **Third-Party & AI Integrations:** OpenAI, Groq SDK, Google Generative AI (Gemini), ScraperAPI
- **File & Image Processing:** Multer, Sharp

## Key Features

- **Scalable Role Management:** Secure, role-based access control supporting diverse internal operational teams (e.g., listers, HR, fulfillment).
- **Core E-commerce APIs:** Comprehensive endpoints for managing custom listing templates, eBay syncing, Amazon lookups, and full order processing pipelines.
- **Workflow Automation:** Integrated multi-provider AI features, automated competitor price scraping, dynamic pricing engines, and scheduled background tasks.
- **HR & Financials:** Robust modules to process employee attendance, payroll handling, transaction tracking, and extra expense management.
- **Performance Optimization:** Built-in caching layers for fast data retrieval and optimized image processing.

## Setup & Local Development

The server requires Node.js (≥ 18.x) and a running MongoDB instance.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure the environment by copying `.env.example` to `.env` and providing the required credentials (e.g., database URI, service API keys).
3. Start the development server:
   ```bash
   npm run dev
   ```

*Note: This is a private application designed exclusively for internal business operations.*
