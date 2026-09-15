// Reads a kitchen sketch (photo or PDF) and returns the runs of cabinets written on it.
// Same shape as the Go Ask Alfie plan readers: the key stays server side, the caller must be
// a signed-in staff member, PDFs go to the API as a document block rather than being rasterised.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5";
const MAX_BYTES = 9_000_000; // base64 payload cap, a page scan is far under this

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PROMPT = `You are reading a kitchen or laundry cabinetry plan drawn by a Hambo's Homemaker Centre designer.
It may be a hand sketch on grid paper, a photo of one, or a printed plan. Read what is written on it. Do not guess a layout.

How these plans are written:
- Every number is millimetres. Decimals are normal (672.50 means 672.5 mm).
- A run of cabinets is drawn as a strip of boxes side by side with each width written in or above its box, and an overall figure written across the top of the whole run.
- A small 20 between boxes, or at the end of a run, is a filler or an end panel, not a cabinet.
- Words written in a box say what that cabinet is: TOP DRAW, D/W, BUTLER SINK, PANTRY 3 INNERS, FRIDGE, OVEN, MICRO, RANGEHOOD, BIN, OPEN SHELF, WALK-IN PANTRY, APPLIANCE CUPBOARD, BROOM, LINEN, WASHER, DRYER.
- A bracketed number under a box, like (1), (2+1) or (3), is the drawer count or drawer layout of that cabinet.
- Overheads are usually drawn as a second, lighter strip above the base run, or noted as O/H.

Return ONLY valid JSON in exactly this shape:
{
  "room": "Kitchen",
  "ceiling_mm": 2700,
  "cabinet_height_mm": 2230,
  "kickboard_mm": 150,
  "door_colour": "White",
  "door_profile": "Shaker",
  "benchtop": "20mm Stone by Hambos",
  "runs": [
    {
      "wall": "rear",
      "overall_mm": 3345,
      "level": "floor",
      "pieces": [
        { "type": "filler", "width_mm": 20 },
        { "type": "base", "width_mm": 672.5, "label": "TOP DRAW", "front": "drawers", "drawers": "1" },
        { "type": "dishwasher", "width_mm": 610, "label": "D/W" },
        { "type": "sink", "width_mm": 610, "label": "BUTLER SINK" },
        { "type": "tall", "width_mm": 680, "label": "PANTRY 3 INNERS", "height_mm": 2230 }
      ]
    }
  ],
  "confidence": "high",
  "notes": "What you could and could not read."
}

Rules for the JSON:
- "type" must be one of: base, sink, corner, tall, island, wall, shelf, floating, filler, endpanel, halfpanel, pole, bbar, blindcorner, blindpantry, onbench, winerack, bin, microwall, microbase, tower, window, cooktop, oven, fridge, dishwasher, microwave, rangehood, appliance.
- Use "wall" for an overhead cupboard and put it in a run with "level": "wall".
- "front" is optional and must be one of: doors, drawers, none, open, glass, pocket, stack, winerack, bin.
- "wall" on a run is one of: rear, left, right, front, island.
- List the pieces of each run in the order they appear along the run, left to right, or top to bottom for a vertical run.
- Give every width you can actually read. If a box has no width written on it, leave width_mm out rather than inventing one.
- Put the overall figure written across the run in overall_mm. If none is written, leave it out.
- Set confidence to high, medium or low for how well the drawing could be read.
- Return nothing except the JSON object.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    // the caller must be a signed-in staff member, the same gate the jobs table uses
    const auth = req.headers.get("Authorization") || "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "Sign in first." }, 401);
    const { data: staff } = await supabase.from("staff").select("email").limit(1);
    if (!staff || !staff.length) return json({ error: "Staff only." }, 403);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "The sketch reader has no API key set on this project yet." }, 501);

    const body = await req.json();
    const b64 = String(body.data || "");
    const isPdf = !!body.pdf;
    if (!b64) return json({ error: "No file sent." }, 400);
    if (b64.length > MAX_BYTES) return json({ error: "That file is too big. Send a page, not the whole document." }, 413);

    const block = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : { type: "image", source: { type: "base64", media_type: String(body.mime || "image/jpeg"), data: b64 } };

    const known: string[] = [];
    if (body.scale_note) known.push(String(body.scale_note));
    if (body.room) known.push(`The designer says this room is the ${body.room}.`);
    const lead = known.length ? known.join(" ") + "\n\n" : "";

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        messages: [{ role: "user", content: [block, { type: "text", text: lead + PROMPT }] }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return json({ error: "The reader could not run.", detail: detail.slice(0, 400) }, 502);
    }
    const out = await res.json();
    let text = (out.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
    if (text.startsWith("```")) text = text.replace(/^```json?\s*\n?/, "").replace(/\n?```\s*$/, "");
    let parsed: any;
    try { parsed = JSON.parse(text); }
    catch { return json({ error: "The reader replied in the wrong format.", raw: text.slice(0, 600) }, 502); }

    return json({ plan: parsed, usage: out.usage || null, model: MODEL });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
