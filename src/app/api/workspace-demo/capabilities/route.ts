import { getAtlasCapabilityRegistry } from "@/lib/workspace-capabilities";

export async function GET() {
  const registry = getAtlasCapabilityRegistry();
  return Response.json({
    ok: true,
    ...registry,
  });
}
