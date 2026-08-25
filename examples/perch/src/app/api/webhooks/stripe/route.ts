/** Stripe billing webhook receiver. */

export async function POST(): Promise<Response> {
  return new Response(null, { status: 501 });
}
