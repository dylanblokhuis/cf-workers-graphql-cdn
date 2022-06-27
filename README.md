# cf-workers-graphql-cdn

Proxies and caches your GraphQL responses on the Cloudflare Network with a stale-while-revalidate strategy.

Implementation by: https://gist.github.com/wilsonpage/a4568d776ee6de188999afe6e2d2ee69

## How to use?
1. Point your GraphQL client to your worker URL.
2. Send a `x-gql-host` header with the origin url e.g. `https://example.org/graphql`

## Development
``npx wrangler dev``

## Publish
``npx wrangler publish src/index.ts --name [your project]``
