/**
 * Landing page served at the root of https://wallet-webhooks.stupidtech.net.
 * Kept in the same minimal, no-CSS style as the rest of stupidtech.net. The
 * product API stays on the `/v1` (/operator) routes.
 */

export const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#111"/>
  <path d="M8 16l10-9 2 6h4l-10 10-3-6H8z" fill="#4ade80"/>
</svg>`;

export const siteHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stupid Wallet Webhooks</title>
  <meta property="og:title" content="Stupid Wallet Webhooks">
  <meta property="og:description" content="Signed webhooks for EVM address activity — top-level transactions, native value, and ERC-20 / ERC-721 transfers.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://wallet-webhooks.stupidtech.net">
  <meta property="og:site_name" content="Stupid Technology">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
  <h1>Stupid Wallet Webhooks</h1>

  <p>Signed webhooks for EVM address activity. Watch an Ethereum address and get a
  cryptographically-signed <code>POST</code> whenever it sends a top-level
  transaction, moves native value, or is involved in an ERC-20 or ERC-721 transfer.</p>

  <h2>What you get</h2>
  <table border="1">
    <thead>
      <tr>
        <th>Capability</th>
        <th>Detail</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Verified deliveries</td>
        <td>HMAC-SHA256 signature over the exact event body
            (<code>webhook-signature: v1,&lt;hex&gt;</code>)</td>
      </tr>
      <tr>
        <td>Activity</td>
        <td>Top-level txs, native transfers, ERC-20 and ERC-721 <code>Transfer</code>s</td>
      </tr>
      <tr>
        <td>Chains</td>
        <td>Ethereum, Base, Optimism, Arbitrum — more on request</td>
      </tr>
      <tr>
        <td>Idempotent</td>
        <td>Deterministic <code>webhook-id</code>; dedupe safely (at-least-once)</td>
      </tr>
      <tr>
        <td>Delivery ledger</td>
        <td>30-day history of every attempt and outcome per webhook</td>
      </tr>
    </tbody>
  </table>

  <h2>The shape of it</h2>
  <pre><code>POST /v1/webhooks        { "url": "https://you.example/hook" }        → returns signing secret once
POST /v1/subscriptions  { "address": "0x1f9…", "chainIds":[8453,10,42161], "webhookId":"wh_…" }
GET  /v1/webhook-deliveries</code></pre>

  <p>Access is provisioned per account (an operator issues your API key) — there's
  no self-serve signup. For access or support, contact
  <a target="_blank" href="mailto:hi@stupidtech.net">hi@stupidtech.net</a>.</p>

  <p>
    Part of <a target="_blank" href="https://stupidtech.net">Stupid Technology</a>.
    Uses <a target="_blank" href="https://evm.stupidtech.net">evm.stupidtech.net</a> for chain access.
  </p>
</body>
</html>`;