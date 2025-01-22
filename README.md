# Advanced Twilio and OpenAI Integration Project

## Overview

This project is an advanced backend server built with **Fastify**, designed to integrate **Twilio** for telephony services and **OpenAI GPT-4** for real-time conversation handling. The application supports voice-based user interactions, session management, WebSocket communication, and third-party API integrations. It features customizable workflows for user authentication, consent handling, live agent escalation, and other automated processes.

---

## Features

1. **Voice Interaction with Twilio**:
   - Handles incoming calls and validates phone numbers.
   - Supports both landline and mobile number verification.
   - Generates TwiML responses dynamically for interaction flow.

2. **OpenAI GPT-4 Integration**:
   - Connects to OpenAI's real-time API to process user queries and responses.
   - Supports personalized question-answering and session management.
   - Enables live-agent-like experiences with predefined workflows.

3. **WebSocket Support**:
   - Real-time communication using WebSockets.
   - Media streaming for Twilio calls integrated with OpenAI responses.

4. **User Authentication and Consent**:
   - Validates user inputs for mobile and landline numbers.
   - Implements consent workflows for sensitive user interactions.

5. **Session Management**:
   - Maintains sessions for active and temporary users.
   - Cleans up inactive sessions periodically.

6. **Third-party Integrations**:
   - Integrates with Google Docs for dynamic message retrieval.
   - Uses Twilio's Lookup API for number validation.
   - Communicates with custom APIs for user-specific data.

7. **Scalability and Error Handling**:
   - Handles concurrent WebSocket connections efficiently.
   - Implements robust error handling and server health monitoring.

---

## Installation and Setup

### Prerequisites
- **Node.js** (v16+ recommended)
- Twilio account with valid `ACCOUNT_SID` and `AUTH_TOKEN`
- OpenAI API key
- `.env` file for environment variables

### Environment Variables
Create a `.env` file with the following keys:
```plaintext
OPENAI_API_KEY=<your_openai_api_key>
TWILIO_ACCOUNT_SID=<your_twilio_account_sid>
TWILIO_AUTH_TOKEN=<your_twilio_auth_token>
PORT=<server_port>
```

## Dependencies

Run the following command to install dependencies:

```bash
npm install
```

## Usage

### Running the Server

Start the server with:

```bash
npm start
```

The server will listen on the specified port (default: `5050`).

---

## API Endpoints

### Twilio Call Handling
- **POST** `/incoming-call`: Handles incoming calls and initiates session validation.
- **POST** `/validate-number`: Validates user-provided numbers.
- **POST** `/confirm-number`: Confirms the number entered by the user.

### WebSocket Endpoints
- **GET** `/user`: WebSocket for user login and consent handling.
- **GET** `/media-stream/:sessionId`: Handles Twilio media streams for live conversations.

### Utility Endpoints
- **GET** `/health`: Returns server health status.
- **GET** `/metrics`: Provides session and memory metrics.

---

## Code Highlights

### Key Functions

#### Number Validation
- **`isLandline(phoneNumber)`**: Checks if a given number is a landline using Twilio's Lookup API.
- **`formatPhoneNumber(rawNumber)`**: Formats raw input into E.164 standard.

#### Twilio Integration
- **`generateTwiML(message, gather, action)`**: Creates TwiML responses dynamically.
- **`sendPhoneNumber(phoneNumber)`**: Sends the phone number to a custom endpoint for processing.

#### OpenAI Integration
- **`initializeOpenAISession(ws, phoneNumber, connection)`**: Sets up OpenAI session with real-time API.
- **`sendOpenAIConversationItem(ws, text)`**: Sends a message to OpenAI for conversation.
- **`handleOpenAIMessage(data, connection, sessionId)`**: Processes OpenAI API responses and forwards audio.

#### WebSocket Management
- **`setupWebSocketEventHandlers(connection, openAiWs, sessionId)`**: Handles WebSocket events for Twilio and OpenAI.
- **`cleanupSessions()`**: Periodically cleans up inactive sessions.

---

## Scalability and Maintenance

### Session Management
- Maintains separate maps for active and temporary sessions.
- Periodic cleanup prevents memory leaks.

### Error Handling
- Centralized error handler for API and WebSocket errors.
- Graceful shutdown on `SIGTERM`.

### Performance
- Efficient chunking of large messages to meet size limits.
- Optimized WebSocket pings for active connections.

---

## Customization

### System Messages
- Update the Google Doc IDs in the code for `SYSTEM_MESSAGE`, `CONSENT_MESSAGE`, and `LIVE_AGENT_MESSAGE` to fetch your content dynamically.

### Twilio Prompts
- Modify the text in `generateTwiML()` for custom voice prompts.

### OpenAI Prompts
- Adjust session instructions and conversation messages for personalized experiences.

---

## Future Enhancements
- Add support for SMS interactions.
- Implement live agent integration.
- Expand error recovery mechanisms for unstable WebSocket connections.

---

## License

This project is licensed under the MIT License.
