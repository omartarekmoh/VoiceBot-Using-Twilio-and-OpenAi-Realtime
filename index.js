import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import axios from "axios";
import crypto from "crypto";
import { getPersonalizedQA } from "../diseases_map.js";

dotenv.config();

const { OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error(
    "Missing required environment variables. Please check .env file."
  );
  process.exit(1);
}

async function fetchGoogleDoc(docId) {
  try {
    const publicUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    const response = await fetch(publicUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const content = await response.text();
    return content;
  } catch (error) {
    console.error("Error fetching Google Doc:", error);
    throw error;
  }
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = await fetchGoogleDoc("SYSTEM_DOC_ID");
const CONSENT_MESSAGE = await fetchGoogleDoc("CONSENT_DOC_ID");
const LIVE_AGENT_MESSAGE = await fetchGoogleDoc("LIVE_AGENT_DOC_ID");

const VOICE = "alloy";
const PORT = process.env.PORT || 5050;

const sessions = new Map();
const tempSessions = new Map();

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

function chunkMessage(message, maxChunkSize = 300) {
  // Initialize result array
  const result = [];

  // First, split by XML/HTML tags to preserve tag structure
  const tagPattern = /(<[^>]+>|[^<]+)/g;
  const elements = message.match(tagPattern) || [];

  let currentChunk = "";
  let openTags = [];

  for (let element of elements) {
    // Check if it's an opening tag
    if (element.match(/^<[^/][^>]*>$/)) {
      openTags.push(element);
      currentChunk += element;
    }
    // Check if it's a closing tag
    else if (element.match(/^<\/[^>]+>$/)) {
      const tagName = element.match(/<\/([^>]+)>/)[1];
      // Remove the matching opening tag from our stack
      openTags = openTags.filter((tag) => !tag.includes(`<${tagName}`));
      currentChunk += element;
    }
    // Text content
    else {
      // Split text content into smaller pieces if needed
      const words = element.split(/\s+/);
      for (let word of words) {
        const potentialChunk = currentChunk + (currentChunk ? " " : "") + word;

        // Check if adding this word would exceed the limit
        if (potentialChunk.length > maxChunkSize && currentChunk) {
          // Add closing tags for any open tags
          let completeChunk = currentChunk;
          const reversedOpenTags = [...openTags].reverse();
          for (let tag of reversedOpenTags) {
            const tagName = tag.match(/<([^\s>]+)/)[1];
            completeChunk += `</${tagName}>`;
          }

          // Add the complete chunk to results
          if (completeChunk.trim()) {
            result.push(completeChunk.trim());
          }

          // Start new chunk with opening tags and current word
          currentChunk = openTags.join("") + word;
        } else {
          currentChunk = potentialChunk;
        }
      }
    }
  }

  // Add any remaining content
  if (currentChunk) {
    // Close any remaining open tags
    const reversedOpenTags = [...openTags].reverse();
    for (let tag of reversedOpenTags) {
      const tagName = tag.match(/<([^\s>]+)/)[1];
      currentChunk += `</${tagName}>`;
    }
    if (currentChunk.trim()) {
      result.push(currentChunk.trim());
    }
  }

  return result;
}

// console.log();

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error(
    "Missing required environment variables. Please check .env file."
  );
  process.exit(1);
}

async function isLandline(phoneNumber) {
  try {
    const response = await axios.get(
      `https://lookups.twilio.com/v1/PhoneNumbers/${phoneNumber}`,
      {
        auth: {
          username: TWILIO_ACCOUNT_SID,
          password: TWILIO_AUTH_TOKEN,
        },
        params: { Type: "carrier" },
      }
    );
    return response.data.carrier.type === "landline";
  } catch (error) {
    console.error(
      "Error checking number type:",
      error.response?.data || error.message
    );
    return false;
  }
}

function generateSessionId(phoneNumber) {
  const cleanNumber = phoneNumber.replace(/\D/g, "");
  return crypto.createHash("sha256").update(cleanNumber).digest("hex");
}

async function sendPhoneNumber(phoneNumber) {
  try {
    const response = await axios.post("ENDPOINT/api/send-message", {
      phoneNumber,
    });
    console.log("Phone number sent successfully:", response.data);
    return response.data;
  } catch (error) {
    console.error(
      "Error sending phone number:",
      error.response?.data || error.message
    );
    throw error;
  }
}

function formatPhoneNumber(rawNumber) {
  rawNumber = rawNumber.replace(/\D/g, "");
  return `+${rawNumber}`;
}

function isValidPhoneNumber(phoneNumber) {
  const phoneRegex = /^[0-9]{10,}$/;
  return phoneRegex.test(phoneNumber);
}

function generateTwiML(
  message,
  gather = false,
  action = "",
  input = "dtmf",
  numDigits = 15
) {
  let twimlResponse = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${message}</Say>`;
  if (gather) {
    twimlResponse += `<Gather input="${input}" ${
      numDigits ? `numDigits="${numDigits}"` : ""
    } action="${action}" method="POST"/>`;
  }
  twimlResponse += "</Response>";
  return twimlResponse;
}

fastify.all("/incoming-call", async (request, reply) => {
  const twilioParams = request.body || request.query;
  const callerNumber = formatPhoneNumber(twilioParams.From);
  const tempSessionId = generateSessionId(callerNumber);

  console.log(`New call from ${callerNumber}`);
  const isLandlineNumber = await isLandline(callerNumber);

  if (isLandlineNumber) {
    tempSessions.set(tempSessionId, {
      callerNumber,
      attempts: 0,
      validated: false,
    });

    const twimlResponse = generateTwiML(
      "Please type your mobile number using your phone's keypad, followed by the pound key.",
      true,
      "/validate-number"
    );
    reply.type("text/xml").send(twimlResponse);
  } else {
    const sessionId = generateSessionId(callerNumber);
    const session = {
      callerNumber,
      phoneNumber: callerNumber,
      attempts: 0,
      validated: false,
    };

    try {
      // const response = await sendPhoneNumber(callerNumber);

      session.validated = true;
      sessions.set(sessionId, session);

      const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Say>YOUR TWILIO PROMPT</Say>
                <Connect>
                    <Stream url="wss://${
                      request.headers.host
                    }/media-stream/${encodeURIComponent(sessionId)}"></Stream>
                </Connect>
            </Response>`;
      return reply.type("text/xml").send(twimlResponse);
    } catch (error) {
      console.error("Error processing number:", error);
      return reply
        .type("text/xml")
        .send(
          generateTwiML(
            "There was an error processing your number. Please try again.",
            true,
            "/validate-number"
          )
        );
    }
  }
});

fastify.post("/validate-number", async (request, reply) => {
  const twilioParams = request.body;
  const callerNumber = formatPhoneNumber(twilioParams.From);
  const tempSessionId = generateSessionId(callerNumber);
  const providedNumber = twilioParams.Digits;

  const tempSession = tempSessions.get(tempSessionId);

  if (!tempSession) {
    return reply
      .type("text/xml")
      .send(generateTwiML("An error occurred. Please call back."));
  }

  tempSession.attempts++;

  if (!isValidPhoneNumber(providedNumber)) {
    const message = "The number you entered isn't valid. Please try again.";
    tempSessions.set(tempSessionId, tempSession);
    return reply
      .type("text/xml")
      .send(generateTwiML(message, true, "/validate-number"));
  }

  try {
    const isLandlineNumber = await isLandline(providedNumber);
    if (isLandlineNumber) {
      const message = "Please provide a mobile number, not a landline.";
      return reply
        .type("text/xml")
        .send(generateTwiML(message, true, "/validate-number"));
    }

    const formattedProvidedNumber = `+${providedNumber}`;
    tempSession.phoneNumber = formattedProvidedNumber;
    tempSessions.set(tempSessionId, tempSession);

    const digits = providedNumber.split("").join(", ");
    const confirmMessage = `You entered, ${digits}. Is that correct? Say yes or no.`;
    return reply
      .type("text/xml")
      .send(generateTwiML(confirmMessage, true, "/confirm-number", "speech"));
  } catch (error) {
    console.error("Error during number validation:", error);
    return reply
      .type("text/xml")
      .send(
        generateTwiML(
          "An error occurred. Please try again.",
          true,
          "/validate-number"
        )
      );
  }
});

fastify.post("/confirm-number", async (request, reply) => {
  const twilioParams = request.body;
  const callerNumber = formatPhoneNumber(twilioParams.From);
  const tempSessionId = generateSessionId(callerNumber);
  const tempSession = tempSessions.get(tempSessionId);
  const confirmation = (twilioParams.SpeechResult || "").toLowerCase();

  if (!tempSession || !tempSession.phoneNumber) {
    return reply
      .type("text/xml")
      .send(generateTwiML("An error occurred. Please call back."));
  }

  if (confirmation.includes("yes")) {
    try {
      const sessionId = generateSessionId(tempSession.phoneNumber);

      const permanentSession = {
        callerNumber: tempSession.callerNumber,
        phoneNumber: tempSession.phoneNumber,
        validated: true,
      };

      sessions.set(sessionId, permanentSession);

      tempSessions.delete(tempSessionId);

      const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Say>YOUR TWILIO PROMPT</say>
                <Connect>
                    <Stream url="wss://${
                      request.headers.host
                    }/media-stream/${encodeURIComponent(sessionId)}"></Stream>
                </Connect>
            </Response>`;
      return reply.type("text/xml").send(twimlResponse);
    } catch (error) {
      console.error("Error processing confirmed number:", error);
      return reply
        .type("text/xml")
        .send(
          generateTwiML(
            "There was an error processing your number. Please try again.",
            true,
            "/validate-number"
          )
        );
    }
  } else if (confirmation.includes("no")) {
    return reply
      .type("text/xml")
      .send(
        generateTwiML(
          "Please enter your number again.",
          true,
          "/validate-number"
        )
      );
  } else {
    return reply
      .type("text/xml")
      .send(
        generateTwiML(
          "I didn't understand. Please say yes or no.",
          true,
          "/confirm-number",
          "speech"
        )
      );
  }
});

fastify.register(async (fastify) => {
  fastify.get("/user", { websocket: true }, (connection) => {
    console.log("User Login WebSocket connected");

    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message);
        // console.log(data);
        handleUserWebSocketMessage(connection, data);
      } catch (error) {
        console.error("Error handling user websocket message:", error);
      }
    });

    connection.on("close", () => {
      console.log("User Login WebSocket closed");
    });
  });
});

fastify.register(async (fastify) => {
  fastify.get(
    "/media-stream/:sessionId",
    { websocket: true },
    (connection, req) => {
      console.log("Raw URL:", req.url);

      const sessionId = req.params.sessionId;
      console.log(`Session ID from params: ${sessionId}`);

      if (!sessionId) {
        console.error("No session ID provided");
        connection.close();
        return;
      }

      const session = sessions.get(sessionId);

      if (!session || !session.validated) {
        console.error("Invalid or unvalidated session");
        connection.close();
        return;
      }

      setupMediaStream(connection, session, sessionId);
    }
  );
});

function setupMediaStream(connection, session, sessionId) {
  console.log("Setting up media stream for session:", {
    sessionId,
    callerNumber: session.callerNumber,
    validated: session.validated,
  });

  let openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const streamSession = {
    ...session,
    transcript: "",
    streamSid: null,
    openAiWs: openAiWs,
    lastActive: Date.now(),
  };
  sessions.set(sessionId, streamSession);

  // Handle WebSocket open event with proper async handling
  openAiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime API");

    // Wrap async operations in an IIFE
    (async () => {
      try {
        // First send phone number
        await sendPhoneNumber(session.phoneNumber);

        // Then initialize session and setup tools
        await initializeOpenAISession(
          openAiWs,
          session.phoneNumber,
          connection
        );
        setupLiveAgentTools(openAiWs);
      } catch (error) {
        console.error("Error during media stream initialization:", error);
        // Handle initialization failure
        if (openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.close();
        }
        connection.close();
        sessions.delete(sessionId);
      }
    })();
  });

  // Handle WebSocket error
  openAiWs.on("error", (error) => {
    console.error("OpenAI WebSocket error:", error);
  });

  // Handle WebSocket close
  openAiWs.on("close", () => {
    console.log("OpenAI WebSocket closed for session:", sessionId);
    // Only delete the session if the connection was explicitly closed by the user
    if (!connection.isAlive) {
      sessions.delete(sessionId);
    }
  });

  // Add connection tracking
  connection.isAlive = true;
  connection.on("pong", () => {
    connection.isAlive = true;
  });

  // Setup connection monitoring
  const pingInterval = setInterval(() => {
    if (connection.isAlive === false) {
      clearInterval(pingInterval);
      connection.terminate();
      return;
    }

    connection.isAlive = false;
    connection.ping();
  }, 30000); // Send ping every 30 seconds to keep connection alive

  console.log("Setting up media stream");
  setupWebSocketEventHandlers(connection, openAiWs, sessionId);

  // Clean up ping interval when connection closes
  connection.on("close", () => {
    clearInterval(pingInterval);
    if (openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
    sessions.delete(sessionId);
  });
}

async function initializeOpenAISession(openAiWs, phoneNumber, connection) {
  try {
    const response = await axios.get("ENDPOINT/api/lookup-phone", {
      params: { phoneNumber },
    });

    if (response.data.success) {
      const { phoneNumber, isLoggedIn, hasConsented, email, password } =
        response.data.data;
      console.log("User data:", response.data.data);

      // Clear existing conversation first
      await clearOpenAISession(openAiWs);

      if (hasConsented && !isLoggedIn) {
        console.log("User has already consented");
        // Send initial greeting first
        const welcomePrompt =
          'Tell the user "Hello! Thank you for your previous consent. How can I help you today?"';
        sendOpenAIConversationItem(openAiWs, welcomePrompt);

        // Then update session with consent message
        setTimeout(() => {
          setupLiveAgentTools(openAiWs);
          sendOpenAISessionUpdate(openAiWs, CONSENT_MESSAGE);
        }, 500);
      } else if (isLoggedIn) {
        const initialPrompt =
          'Tell the user "Please hold a second logging you in."';
        sendOpenAIConversationItem(openAiWs, initialPrompt);

        await axios.post("ENDPOINT/api/login", {
          phoneNumber,
          email,
          password,
        });
      } else {
        const initialPrompt =
          'Tell the user "Hello! This is the voice bot. To proceed, please provide your consent by clicking the link sent to you in the message"';
        sendOpenAIConversationItem(openAiWs, initialPrompt);

        setTimeout(() => {
          setupLiveAgentTools(openAiWs);
          sendOpenAISessionUpdate(openAiWs, SYSTEM_MESSAGE);
        }, 500);
      }
    }
  } catch (error) {
    console.error("Error initializing OpenAI session:", error);
    handleSessionError(
      openAiWs,
      "There was an error connecting to the service. Please try again."
    );
  }
}

function handleSessionError(openAiWs, errorMessage) {
  sendOpenAISessionUpdate(openAiWs, errorMessage);
  sendOpenAIConversationItem(openAiWs, `Tell the user: "${errorMessage}"`);
}

function setupWebSocketEventHandlers(connection, openAiWs, sessionId) {
  connection.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      handleMediaStreamMessage(data, openAiWs, sessionId);
    } catch (error) {
      console.error("Error handling media stream message:", error);
    }
  });

  openAiWs.on("message", (data) => {
    handleOpenAIMessage(data, connection, sessionId);
  });

  connection.on("close", () => {
    if (openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
    sessions.delete(sessionId);
  });

  openAiWs.on("error", (error) => {
    console.error("OpenAI WebSocket error:", error);
  });
}

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`Server is running on port ${PORT}`);
});

async function clearOpenAISession(ws) {
  const clearSession = {
    type: "session.update",
    session: {
      turn_detection: { type: "server_vad" },
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      model: "gpt-4o-realtime-preview-2024-12-17",
      max_response_output_tokens: "inf",
      voice: VOICE,
      instructions:
        "Forget everything in the past that the user or assistant or system, your new prompt will start after i tell you, your new prompt starts from this sign <prompt> and ends with this sign </prompt> so act accordingly.",
      temperature: 1,
      input_audio_transcription: {
        model: "whisper-1",
      },
      tool_choice: "auto",
    },
  };
  ws.send(JSON.stringify(clearSession));

  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function sendOpenAISessionUpdate(ws, instructions) {
  // const chunks = chunkMessage(instructions);

  // Send new session instructions with first chunk
  const sessionUpdate = {
    type: "session.update",
    session: {
      turn_detection: { type: "server_vad" },
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      voice: VOICE,
      instructions: `<prompt> ${instructions} </prompt>`,
      temperature: 1,
      input_audio_transcription: {
        model: "whisper-1",
      },
      tool_choice: "auto",
    },
  };
  ws.send(JSON.stringify(sessionUpdate));
}

function sendOpenAIConversationItem(ws, text) {
  const conversationItem = {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [{ type: "input_text", text }],
    },
  };
  ws.send(JSON.stringify(conversationItem));
  ws.send(
    JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
      },
    })
  );
}

function handleMediaStreamMessage(data, openAiWs, sessionId) {
  if (data.event === "start") {
    const session = sessions.get(sessionId);
    if (session) {
      session.streamSid = data.start.streamSid;
      sessions.set(sessionId, session);
    }
  }

  if (data.event === "media" && openAiWs.readyState === WebSocket.OPEN) {
    const audioAppend = {
      type: "input_audio_buffer.append",
      audio: data.media.payload,
    };

    openAiWs.send(JSON.stringify(audioAppend));
  }
}

async function handleOpenAIMessage(data, connection, sessionId) {
  try {
    const response = JSON.parse(data);
    // console.log(response);
    const session = sessions.get(sessionId);

    if (!session) {
      console.error("Invalid session handle openai message");
      return;
    }

    if (response.type === "response.audio.delta" && response.delta) {
      connection.send(
        JSON.stringify({
          event: "media",
          streamSid: session.streamSid,
          media: { payload: response.delta },
        })
      );
    }

    if (response.type === "response.function_call_arguments.done") {
      if (response.name == "transfer_to_live_agent") {
        console.log("Transfered to a live agent");
        const delay = 3000;
        setTimeout(() => {
          handleTransferAgentCall(response, connection, session);
        }, delay);
      }
      if (response.name == "replace_sensor") {
        console.log("Replace Sensor");
        await handleReplaceSensor(response, connection, session);
      }
    }
  } catch (error) {
    console.error("Error processing OpenAI message:", error);
  }
}

function handleTransferAgentCall(response, connection, session) {
  try {
    console.log("TRANSFERRED TO LIVE AGENT");
    const functionOutput = {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: response.call_id,
        output: response.arguments,
      },
    };
    session.openAiWs.send(JSON.stringify(functionOutput));

    // Clear existing session first
    clearOpenAISession(session.openAiWs).then(() => {
      // Send initial agent message
      sendOpenAIConversationItem(
        session.openAiWs,
        "Tell the user  Hi, This is the human agent experience. For now, this is only a demo, and the full version will include live agent support."
      );

      // Update session with live agent message after a delay
      setTimeout(() => {
        setupLiveAgentTools(session.openAiWs);
        sendOpenAISessionUpdate(session.openAiWs, LIVE_AGENT_MESSAGE);
      }, 500);
    });
  } catch (error) {
    console.error("Error handling function call:", error);
  }
}

async function handleReplaceSensor(response, connection, session) {
  try {
    const apiResponse = await axios.post(
      "ENDPOINT/api/send-user-info-request",
      { phoneNumber: session.phoneNumber }
    );

    if (session.openAiWs.readyState === WebSocket.OPEN) {
      const functionOutput = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: response.call_id,
          output: response.arguments,
        },
      };

      sendOpenAIConversationItem(
        session.openAiWs,
        `Tell the user "In order to process your replacement, I will send you a text message where you can provide us with your full name, email address, and shipping address. Please reply to the message with the requested details in one message, and we'll take it from there!"`
      );

      session.openAiWs.send(JSON.stringify(functionOutput));
    } else {
      console.error("WebSocket connection closed - attempting to reconnect");
      await reconnectOpenAIWebSocket(session, sessionId);
    }
  } catch (error) {
    console.error("Error handling sensor replacement:", error);
    // Attempt to reconnect if the connection was lost
    if (session.openAiWs.readyState !== WebSocket.OPEN) {
      await reconnectOpenAIWebSocket(session, sessionId);
    }
  }
}

function handleUserWebSocketMessage(socket, data) {
  if (!data.phoneNumber) {
    console.error("No phone number provided in websocket message");
    return;
  }

  const sessionId = generateSessionId(data.phoneNumber);
  const session = sessions.get(sessionId);

  if (!session) {
    console.error(
      `No active session found for phone number: ${data.phoneNumber}`
    );
    return;
  }

  if (!session.openAiWs || session.openAiWs.readyState !== WebSocket.OPEN) {
    console.error("OpenAI WebSocket not connected for session:", sessionId);
    return;
  }

  try {
    switch (data.event) {
      case "user_login":
        handleUserLogin(session.openAiWs, {
          ...data,
          session: session,
        });
        break;
      case "user_consent":
        handleUserConsent(session.openAiWs, {
          ...data,
          session: session,
        });
        break;
      case "user_send_sms":
        handleUserSendSms(session.openAiWs, {
          ...data,
          session: session,
        });
        break;
      default:
        console.log("Unknown event type:", data.event);
    }
  } catch (error) {
    console.error("Error handling websocket message:", error);
    // Attempt to reconnect OpenAI WebSocket if needed
    if (session.openAiWs.readyState !== WebSocket.OPEN) {
      reconnectOpenAIWebSocket(session, sessionId);
    }
  }
}

async function reconnectOpenAIWebSocket(session, sessionId) {
  try {
    console.log(
      "Attempting to reconnect OpenAI WebSocket for session:",
      sessionId
    );

    let openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    openAiWs.on("open", () => {
      console.log("Reconnected to OpenAI Realtime API for session:", sessionId);
      session.openAiWs = openAiWs;
      sessions.set(sessionId, session);

      // Reinitialize the session
      initializeOpenAISession(openAiWs, session.phoneNumber);
      setupLiveAgentTools(openAiWs);
    });

    openAiWs.on("error", (error) => {
      console.error("Error in reconnected OpenAI WebSocket:", error);
    });

    openAiWs.on("close", () => {
      console.log(
        "Reconnected OpenAI WebSocket closed for session:",
        sessionId
      );
    });
  } catch (error) {
    console.error("Failed to reconnect OpenAI WebSocket:", error);
  }
}

function handleUserLogin(socket, data) {
  const userName = data.name || "User";
  const { qa } = getPersonalizedQA(userName, scenarioIds, latestGlucoseValue);

  try {
    // First clear the session
    clearOpenAISession(socket)
      .then(() => {
        // Send welcome message immediately
        const welcomePrompt = `Tell the user this "Hello ${userName} how can i help you"`;
        sendOpenAIConversationItem(socket, welcomePrompt);

        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) {
            setupLiveAgentTools(socket);
            sendOpenAISessionUpdate(socket, CONSENT_MESSAGE + qa);
          }
        }, 500);
      })
      .catch((error) => {
        console.error("Error clearing OpenAI session:", error);
      });
  } catch (error) {
    console.error("Error handling user consent:", error);
  }
}

function handleUserConsent(socket, data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.error("Invalid socket state in handleUserConsent");
    return;
  }

  console.log(`User consent received for phone number: ${data.phoneNumber}`);

  try {
    // First clear the session
    clearOpenAISession(socket)
      .then(() => {
        // Send welcome message immediately
        const welcomePrompt =
          'Tell the user "Thank you for providing consent. How can I help you today?"';
        sendOpenAIConversationItem(socket, welcomePrompt);

        // Update with consent message after a delay
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) {
            setupLiveAgentTools(socket);
            sendOpenAISessionUpdate(socket, CONSENT_MESSAGE);
          }
        }, 500);
      })
      .catch((error) => {
        console.error("Error clearing OpenAI session:", error);
      });
  } catch (error) {
    console.error("Error handling user consent:", error);
  }
}

function handleUserSendSms(socket, data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.error("Invalid socket state in handleUserConsent");
    return;
  }

  console.log(`User message received for phone number: ${data.phoneNumber}`);

  try {
    // First clear the session
    clearOpenAISession(socket)
      .then(() => {
        // Send welcome message immediately
        const welcomePrompt = `Tell the user We stored your information. Our team will contact you soon. Thanks!. How else can I help you"`;
        sendOpenAIConversationItem(socket, welcomePrompt);
      })
      .catch((error) => {
        console.error("Error clearing OpenAI session:", error);
      });
  } catch (error) {
    console.error("Error handling user consent:", error);
  }
}

function setupLiveAgentTools(ws) {
  const toolsUpdate = {
    type: "session.update",
    session: {
      tools: [
        {
          type: "function",
          name: "transfer_to_live_agent",

          description:
            "Transfer the customer to a human agent for further assistance.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          type: "function",
          name: "replace_sensor",
          description:
            "when the user asks for a sensor replacement we send him a message to get his data and proceed with sending the sensor.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      ],
      tool_choice: "auto",
    },
  };
  ws.send(JSON.stringify(toolsUpdate));
}

// Update the cleanup function to only remove truly abandoned sessions
function cleanupSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    // Only cleanup if the WebSocket is closed and no active connection exists
    if (
      session.openAiWs &&
      session.openAiWs.readyState === WebSocket.CLOSED &&
      (!session.connection || !session.connection.isAlive)
    ) {
      sessions.delete(sessionId);
    }
  }

  // Clean temporary sessions after 2 hours of inactivity
  for (const [sessionId, session] of tempSessions.entries()) {
    if (session.timestamp && now - session.timestamp > 7200000) {
      tempSessions.delete(sessionId);
    }
  }
}
setInterval(cleanupSessions, 3600000);

fastify.setErrorHandler((error, request, reply) => {
  console.error("Server error:", error);
  reply.status(500).send({
    error: "Internal Server Error",
    message: "An unexpected error occurred",
  });
});

fastify.get("/health", async (request, reply) => {
  return { status: "healthy", timestamp: new Date().toISOString() };
});

fastify.get("/metrics", async (request, reply) => {
  return {
    activeSessions: sessions.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  };
});

process.on("SIGTERM", async () => {
  console.log("Received SIGTERM. Starting graceful shutdown...");

  for (const [sessionId, session] of sessions.entries()) {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.close();
    }
  }

  sessions.clear();

  await fastify.close();
  console.log("Server shut down gracefully");
  process.exit(0);
});

export default fastify;
