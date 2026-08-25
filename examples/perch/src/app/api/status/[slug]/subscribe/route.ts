/** Public subscribe endpoint for a status page. */

export async function POST(): Promise<Response> {
  return new Response(null, { status: 501 });
}
