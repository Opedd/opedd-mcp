# opedd-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for the [Opedd](https://opedd.com) licensing protocol. Lets AI assistants (Claude Desktop, Cursor, Windsurf, or any MCP-compatible host) discover, purchase, and verify content licenses autonomously — mid-conversation, without opening a browser.

## What it does

Exposes 4–5 tools to any AI assistant:

| Tool | Description |
|------|-------------|
| `lookup_content` | Look up an article by URL — returns title, publisher, pricing |
| `purchase_license` | Buy a license with a Stripe payment method — returns license key |
| `verify_license` | Verify a license key — returns validity, article, publisher, blockchain proof |
| `browse_registry` | Browse the public Opedd registry (global or by publisher) |
| `list_publisher_content` | *(requires API key)* List your own articles with pricing and stats |

## Install

```bash
npm install -g opedd-mcp
```

Or run directly with npx:

```bash
npx opedd-mcp
```

## Configuration

Set environment variables to pre-configure the server:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPEDD_BUYER_EMAIL` | Recommended | Your email — used as default for all purchases |
| `OPEDD_PAYMENT_METHOD_ID` | Recommended | Stripe `pm_...` ID — used for autonomous purchasing |
| `OPEDD_API_KEY` | Optional | Publisher API key (`op_...`) — enables `list_publisher_content` |
| `OPEDD_API_URL` | Optional | Override the API base URL (default: Opedd production) |

> **Getting a Stripe payment method ID**: Save a card in your Stripe account and retrieve the `pm_...` ID via the [Stripe API](https://stripe.com/docs/api/payment_methods).

## Claude Desktop setup

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "opedd": {
      "command": "npx",
      "args": ["opedd-mcp"],
      "env": {
        "OPEDD_BUYER_EMAIL": "you@yourcompany.com",
        "OPEDD_PAYMENT_METHOD_ID": "pm_..."
      }
    }
  }
}
```

## Cursor / Windsurf setup

Add to your MCP settings:

```json
{
  "opedd": {
    "command": "npx opedd-mcp",
    "env": {
      "OPEDD_BUYER_EMAIL": "you@yourcompany.com",
      "OPEDD_PAYMENT_METHOD_ID": "pm_..."
    }
  }
}
```

## Example usage

Once configured, you can ask your AI assistant:

> "Look up the licensing options for this article: https://theinformation.com/articles/..."

> "Purchase a human republication license for that article on my behalf."

> "Verify license key OP-XXXX-XXXX and tell me what it covers."

> "Browse the latest licenses from The Information publisher."

The assistant will call the appropriate Opedd tools, show you the results, and—if you've pre-configured a payment method—can complete a purchase autonomously.

## Payment methods

Purchases use **Stripe** by default (via `pm_...` payment method IDs). USDC on Base is also supported by the Opedd API — pass `payment: { method: 'usdc', tx_hash: '0x...' }` directly to `agent-purchase` if building a custom integration.

## Development

```bash
git clone https://github.com/Opedd/opedd-mcp
cd opedd-mcp
npm install
npm run dev   # runs with tsx (no build step)
npm run build # compiles to dist/
```

## License

MIT
