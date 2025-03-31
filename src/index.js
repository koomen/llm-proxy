// Configuration values – customize these for your setup
const ALLOWED_ORIGIN = "https://koomen.dev";
const MAX_PROMPT_LENGTH = 1000;     // maximum characters allowed in the prompt
const MAX_RESPONSE_LENGTH = 5000;   // maximum characters allowed in the response

// The URL for the OpenAI Responses API endpoint.
// Adjust this URL as needed for your target API.
const OPENAI_API_URL = "https://api.openai.com/v1/responses";

// This secret should be bound as an environment variable in your Worker settings.
const OPENAI_API_KEY = OPENAI_API_KEY_ENV; // for example, bind 'OPENAI_API_KEY_ENV' in your KV or secrets

/**
 * Handles incoming requests by validating CORS, limiting prompt length,
 * forwarding the request to OpenAI with streaming enabled, and then
 * limiting the response length as it streams back to the client.
 */
async function handleRequest(request) {
  const origin = request.headers.get("Origin");
  if (origin !== ALLOWED_ORIGIN) {
    return new Response("Forbidden", { status: 403 });
  }

  // Handle preflight (OPTIONS) request for CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // Only allow POST requests
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Parse JSON payload and validate prompt
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response("Bad Request: Invalid JSON", { status: 400 });
  }

  let { prompt } = body;
  if (!prompt) {
    return new Response("Bad Request: Missing prompt", { status: 400 });
  }

  // Limit prompt length if necessary
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return new Response(`Bad Request: Max prompt length exceeded (${prompt.length}>${MAX_PROMPT_LENGTH}`, { status: 400 });
  }

  // Prepare the request payload for OpenAI.
  // Note: adjust parameters as needed by your specific OpenAI API.
  const openaiPayload = JSON.stringify({
    prompt,
    stream: true,
    // ... add any other parameters required by the API
  });

  // Forward the request to OpenAI
  const openaiResponse = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: openaiPayload,
  });

  // If the OpenAI API returns an error, pass that back to the client.
  if (!openaiResponse.ok) {
    return new Response("Error from OpenAI API", { status: 500 });
  }

  // Create a new ReadableStream that will pass along the streaming response.
  // We count the total response length and stop streaming if it exceeds MAX_RESPONSE_LENGTH.
  const { readable } = new ReadableStream({
    async start(controller) {
      const reader = openaiResponse.body.getReader();
      const textDecoder = new TextDecoder();
      const textEncoder = new TextEncoder();
      let totalLength = 0;

      async function push() {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          // Decode the chunk and check its length.
          const chunkText = textDecoder.decode(value, { stream: true });
          if (totalLength + chunkText.length > MAX_RESPONSE_LENGTH) {
            // Calculate how many more characters we can send.
            const allowed = MAX_RESPONSE_LENGTH - totalLength;
            const trimmed = chunkText.substring(0, allowed);
            controller.enqueue(textEncoder.encode(trimmed));
            controller.close();
            return;
          }
          totalLength += chunkText.length;
          controller.enqueue(value);
          push();
        } catch (error) {
          controller.error(error);
        }
      }
      push();
    }
  });

  // Return the streaming response with proper CORS headers.
  return new Response(readable, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    },
  });
}

// Listen for the fetch event
addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});
