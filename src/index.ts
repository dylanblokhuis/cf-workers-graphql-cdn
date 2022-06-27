/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `wrangler dev src/index.ts` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `wrangler publish src/index.ts --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import swr from "./swr"

export interface Env {
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  // MY_KV_NAMESPACE: KVNamespace;
  //
  // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  //
  // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
  // MY_BUCKET: R2Bucket;
}


export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(
        "Only POST requests are supported",
        { status: 405 }
      )
    }

    const host = request.headers.get("x-gql-host")
    if (!host) {
      return new Response(
        "Missing x-gql-host header",
        { status: 400 }
      )
    }

    if (typeof request.headers.get("content-type") !== "string" && request.headers.get("content-type") !== "application/json") {
      return new Response(
        "Missing content-type header or content-type is not application/json",
        { status: 400 }
      )
    }

    const req = new Request(host, {
      method: "POST",
      body: request.body,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=1, stale-while-revalidate=31536000, stale-if-error=31536000",
      }
    })

    return swr({ request: req, ctx });
  },
};