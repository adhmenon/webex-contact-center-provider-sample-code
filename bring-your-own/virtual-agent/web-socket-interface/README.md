# Build a BYOVA connector over WebSocket

Use this guide to implement, register, configure, test, and operate a Bring Your Own Virtual Agent (BYOVA) connector for Webex Contact Center. Your connector exposes two secure WebSocket endpoints: `/v1/va` for a live conversation and `/v1/listVirtualAgents` for virtual-agent discovery. Webex opens one `/v1/va` connection for each conversation and exchanges JSON text frames containing events and Base64-encoded audio.

Bring Your Own Data Source (BYODS) supplies the control plane: customer authorization, schema selection, endpoint registration, and runtime trust. It does not carry live audio. Use the [BYOVA over WebSocket guide](https://developer.webex.com/mcp/docs/bring-your-own-virtual-agent-over-websocket) and the [public AsyncAPI specifications](https://github.com/webex/dataSourceSchemas/tree/main/Services/VoiceVirtualAgent_WebSocket/a38a10b7-43e4-4676-a076-a7d6dce9387d/AsyncApiSpec) as the authoritative public contract.

> **Important:** The WebSocket schema ID is `a38a10b7-43e4-4676-a076-a7d6dce9387d`. Select this value in the Service App and use it in every WebSocket data-source registration. Do not use the BYOVA gRPC schema ID; the two schemas are not interchangeable.

## What you will build

Implement and operate these partner-hosted endpoints:

| Endpoint | Purpose | Connection scope | Payload family |
| --- | --- | --- | --- |
| `/v1/va` | Exchange caller audio, virtual-agent responses, DTMF, events, errors, and heartbeats | One long-lived connection for one `conversation_id`; reuse it for all turns | Enveloped `VOICE_VA_REQUEST`, `VOICE_VA_RESPONSE`, `ERROR`, `PING`, and `PONG` objects |
| `/v1/listVirtualAgents` | Return the virtual agents available to a customer organization | A separate, short request-response connection | Bare `ListVARequest` and `ListVAResponse` objects |

Keep the control plane separate from the runtime path:

| Plane | Provider responsibility | Customer/Webex responsibility | Credential used |
| --- | --- | --- | --- |
| Service App and BYODS control plane | Create the Service App; request data-source scopes; register, rotate, disable, and offboard each customer data source | A customer Full Admin authorizes the Service App | Customer-specific Service App OAuth access token |
| Contact Center configuration | Supply the registered data source and available-agent catalog | A customer administrator creates the CCAI configuration, configures the flow, publishes it, and maps an entry point | Control Hub authorization |
| Live WebSocket path | Host both endpoints; validate the bearer JSON Web Signature (JWS); process media and events; operate the connector | Webex resolves the registration, opens the socket, sends caller input, paces partner audio, and executes configured handoff | Current data-source JWS presented by Webex during the HTTP upgrade |

Own speech recognition, voice activity and end-of-turn detection, agent or large-language-model reasoning, response generation, and text-to-speech or speech-to-speech adaptation inside your connector. Do not implement Webex internal gRPC services for this transport.

## Before you begin

Confirm these prerequisites before you register a customer:

- Host a partner-owned public DNS domain and obtain a valid TLS certificate whose hostname and trust chain match that domain.
- Expose `/v1/va` and `/v1/listVirtualAgents` through `wss://` on TCP port 443 unless Webex has approved another port for the target environment.
- Preserve WebSocket upgrade headers, the `Authorization` header, JSON text frames, application heartbeat traffic, and long-lived connections through every proxy, web application firewall, ingress, and load balancer.
- Obtain access to create a Service App in Webex for Developers.
- Identify a Full Admin for each customer Webex organization. That administrator must authorize the Service App and configure Webex Contact Center.
- Confirm that BYOVA over WebSocket is available for the target organization through your established Webex channel. This repository does not define tenant entitlement or enablement.
- Install JDK 21 and allow Maven Central access if you plan to run the Java simulator. The repository includes a Maven wrapper, so a separate Maven installation is not required for the documented commands.
- Install a WebSocket client such as `wscat` for local smoke tests.

Do not use the sample's plaintext endpoint, disabled authentication, prerecorded audio, or hard-coded catalog in a Webex-connected environment.

## Understand the onboarding sequence

Complete the integration in this order. The owner column prevents a provider from attempting a customer-only Control Hub action, or a customer from handling provider secrets.

| Step | Owner | Action | Expected result |
| --- | --- | --- | --- |
| 1 | Provider | Implement both WebSocket paths and production authentication/TLS behavior | The connector is reachable and validates the public contract |
| 2 | Provider | Create one Service App with the data-source scopes, WebSocket schema, and exchange domain | The app accurately describes the intended data exchange |
| 3 | Customer Full Admin | Authorize that Service App in Control Hub | Webex creates an organization-specific machine account |
| 4 | Provider | Retrieve and securely store that organization's OAuth access/refresh token pair | The provider can manage data sources for that organization |
| 5 | Provider | Register one WebSocket data source with `POST /v1/dataSources` | The response contains a data-source ID and active registration state |
| 6 | Customer administrator | Select the same Service App/data source in a Contact Center AI configuration | Contact Center can resolve the connector |
| 7 | Customer flow author | Configure and publish a flow with the Virtual Agent Voice activity, then map an entry point | Calls can enter the BYOVA flow |
| 8 | Provider and customer | Place an end-to-end test call and validate authentication, media, events, and handoff | The complete path works for the intended organization |
| 9 | Provider | Automate Service App OAuth renewal and data-source runtime-token rotation as separate jobs | Management access and runtime registration remain current |

Create only one Service App for this integration. The WebSocket schema identifies the transport; Control Hub does not require a second Service App or a separate WebSocket selector.

## Create the Service App

Create the Service App as the provider developer:

1. Sign in to Webex for Developers.
2. Open **My Webex Apps**.
3. Select **Create a New App**.
4. Select **Create Service App**.
5. Enter the required name, description, logo, and contact information so that a customer Full Admin can identify the provider and purpose.
6. Store the client secret in a secret manager when Webex displays it. Do not put it in source code, an image, a support ticket, or a repository secret file.
7. In **Bring Your Own Datasource Settings**, select only these scopes for the data-source work:
   - `spark-admin:datasource_read`
   - `spark-admin:datasource_write`
8. Select **Data Exchange Schema** `a38a10b7-43e4-4676-a076-a7d6dce9387d`.
9. Enter the partner-owned **Data Exchange Domain**, for example `byova.example.com`.
10. Enter only a domain. Omit `wss://`, a port, a path, and wildcard characters. The host in each later data-source URL must fall within an authorized domain.
11. Save the Service App.

For your own Webex organization, use **Request Admin Authorization** to make the app available to its administrators. For an organization that is not affiliated with the developer, follow the current [Service Apps](https://developer.webex.com/create/docs/service-apps) process for App Hub discovery and authorization. Do not assume that creating the app makes it visible to every customer.

Record the following non-secret configuration in your onboarding system:

- Service App application ID
- WebSocket schema ID
- Authorized exchange domain
- Requested data-source scopes
- Customer organization that must authorize the app

Keep the client secret separate from those values.

## Authorize the Service App in Control Hub

Ask a Full Admin in the customer organization to complete these actions:

1. Sign in to Control Hub.
2. Navigate to **Management** > **Apps** > **Service Apps**.
3. Locate the provider's Service App.
4. Review the developer, purpose, requested scopes, Data Exchange Domain, and Data Exchange Schema.
5. Confirm that the domain and schema match the planned WebSocket deployment.
6. Select **Authorize**.
7. Select **Save**.

The authorization creates a machine account in that customer organization. It does not grant the provider access to unrelated organizations.

Treat later Service App changes as a new authorization boundary. If you change scopes, an exchange domain, or a schema, ask the Full Admin to deauthorize and then reauthorize the updated app. Deauthorization deletes the machine account and invalidates its tokens. If your onboarding system needs an automated signal, use the authorization and deauthorization webhooks documented on the Service Apps page.

Expected result: the organization appears under the Service App's **Org Authorizations** section, and the provider can retrieve organization-specific tokens.

## Retrieve and protect customer-specific Service App tokens

Open the Service App's **Org Authorizations** section and retrieve the access and refresh token pair for the authorized organization. Store each customer's pair under a separate tenant key and restrict it to the system that manages that customer's data source.

Use the tokens as follows:

| Credential | Purpose | Never use it for |
| --- | --- | --- |
| Service App access token | Call `https://webexapis.com/v1/dataSources` for the authorizing organization | A live WebSocket `Authorization` header from the provider to Webex |
| Service App refresh token | Renew the Service App OAuth access token | Rotating the data-source nonce or runtime JWS |
| Runtime data-source JWS | Validate an inbound Webex WebSocket upgrade | Calling the Data Sources REST API |

The current Service Apps documentation describes an access token as typically valid for 14 days and a refresh token as typically valid for 90 days. Treat those values as current documentation, not as a substitute for inspecting actual expiry and handling refresh failures.

Automate token retrieval with the Service Apps token endpoint documented at `POST /v1/applications/{appId}/token`. Authenticate that request with a Personal Access Token or a separate integration token that has `spark:applications_token`, and supply the Service App `clientId`, `clientSecret`, and `targetOrgId` in the JSON body. Follow the live Service Apps reference rather than copying secrets into a command history.

Do not use the personal token shown in a Developer Portal **Try It** panel for Data Sources API requests. Use the customer-specific Service App access token with the two data-source scopes.

## Register the WebSocket data source

Register one data source for each customer organization. Use the OAuth access token obtained for that organization.

### Prepare the registration body

Create a file named `registration.json` with the current request shape:

```json
{
  "schemaId": "a38a10b7-43e4-4676-a076-a7d6dce9387d",
  "url": "wss://byova.example.com",
  "audience": "example-byova-connector",
  "subject": "voice-virtual-agent",
  "nonce": "<unique-unpredictable-value>",
  "tokenLifetimeMinutes": 60
}
```

Replace every example value. Keep these rules:

| Field | Type | Required value and validation |
| --- | --- | --- |
| `schemaId` | String | Use exactly `a38a10b7-43e4-4676-a076-a7d6dce9387d` for BYOVA over WebSocket |
| `url` | String | Use the public WebSocket base URL on the authorized domain; expose the standard `/v1/va` and `/v1/listVirtualAgents` paths on that host |
| `audience` | String | Choose a stable connector audience; later require the same value in JWS `aud` |
| `subject` | String | Choose a stable function or service subject; later require the same value in JWS `sub` |
| `nonce` | String | Generate a unique, unpredictable value for this customer registration and each rotation; later bind it to JWS `jti` |
| `tokenLifetimeMinutes` | Number | Choose a value from 1 through 1440 minutes and rotate before expiry |

Register the exact URL expected by the current BYOVA WebSocket configuration. Do not infer or publish custom path-rewrite behavior. The standard connector must serve both documented paths, and your token validator must compare the signed URL claim with the value you registered.

> **Note:** The current live Data Sources API defines `schemaId` as a string and `tokenLifetimeMinutes` as a number. An older general BYODS example shows a `schemaId` array and `tokenLifeMinutes`; do not copy those stale shapes.

### Call the registration API

Set `SERVICE_APP_ACCESS_TOKEN` in a secure execution environment, then run:

```bash
curl --request POST \
  --url https://webexapis.com/v1/dataSources \
  --header "Authorization: Bearer ${SERVICE_APP_ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --data @registration.json
```

Parse and store the returned data-source `id` with the customer record. Tolerate additive response fields instead of binding your automation to an entire example response.

Do not persist a returned `jwsToken` for replay on future connections. Webex presents a current data-source JWS when it opens each runtime WebSocket. The token visible in a registration or GET response is useful for inspecting the claim/configuration shape, not for authenticating a later socket yourself.

### Verify the registration

Use the returned ID:

```bash
export DATA_SOURCE_ID='<returned-data-source-id>'

curl --request GET \
  --url "https://webexapis.com/v1/dataSources/${DATA_SOURCE_ID}" \
  --header "Authorization: Bearer ${SERVICE_APP_ACCESS_TOKEN}"
```

Verify these expected results:

- `status` is `active`.
- `schemaId`, `orgId`, and `applicationId` match the intended schema, customer organization, and Service App.
- Decode the returned `jwsToken` payload locally for inspection without treating it as authenticated input. Confirm that `aud`, `sub`, `jti`, `exp`, `com.cisco.datasource.url`, `com.cisco.datasource.schema.uuid`, and `com.cisco.org.uuid` match the registration and intended customer.
- The difference between the JWS `iat` and `exp` claims matches the requested lifetime and provides enough time for scheduled rotation.
- The URL claim's host belongs to the Data Exchange Domain that the customer authorized.

Use the live [Data Sources API](https://developer.webex.com/admin/docs/api/v1/data-sources) reference whenever its schema changes.

## Maintain, disable, and offboard the data source

Use this lifecycle instead of treating registration as a one-time step:

| Operation | Method and path | Credential | Use |
| --- | --- | --- | --- |
| Register | `POST /v1/dataSources` | Service App access token with `spark-admin:datasource_write` | Create a customer registration |
| List | `GET /v1/dataSources` | Service App access token with `spark-admin:datasource_read` | Find registrations created by this Service App |
| Retrieve | `GET /v1/dataSources/{dataSourceId}` | Service App access token with `spark-admin:datasource_read` | Check configuration, status, and expiry |
| Update | `PUT /v1/dataSources/{dataSourceId}` | Service App access token with data-source write access | Rotate or change the complete intended registration |
| Disable | `PUT /v1/dataSources/{dataSourceId}` | Service App access token with data-source write access | Temporarily prevent use and expose an administrator-facing reason |
| Delete | `DELETE /v1/dataSources/{dataSourceId}` | Service App access token with data-source write access | Permanently offboard the registration |
| List schemas | `GET /v1/dataSources/schemas` | Valid API access token as documented by the operation | Discover available schemas |
| Retrieve schema | `GET /v1/dataSources/schemas/{schemaId}` | Valid API access token as documented by the operation | Inspect one schema record |

### Rotate the runtime registration

Rotate the data-source material before its expiry. Generate a new unpredictable nonce and send a full intended registration rather than a sparse patch. For example, save this as `registration-rotation.json`:

```json
{
  "schemaId": "a38a10b7-43e4-4676-a076-a7d6dce9387d",
  "url": "wss://byova.example.com",
  "audience": "example-byova-connector",
  "subject": "voice-virtual-agent",
  "nonce": "<new-unique-unpredictable-value>",
  "tokenLifetimeMinutes": 60,
  "status": "active"
}
```

Then update and retrieve the resource:

```bash
curl --request PUT \
  --url "https://webexapis.com/v1/dataSources/${DATA_SOURCE_ID}" \
  --header "Authorization: Bearer ${SERVICE_APP_ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --data @registration-rotation.json

curl --request GET \
  --url "https://webexapis.com/v1/dataSources/${DATA_SOURCE_ID}" \
  --header "Authorization: Bearer ${SERVICE_APP_ACCESS_TOKEN}"
```

Confirm the new nonce/expiry and `active` status. Test a new WebSocket connection against the new runtime token. Keep this rotation job separate from the job that refreshes the Service App OAuth access token: they manage different credentials and different expiries.

### Disable a broken data source

To stop new use without deleting the registration, send the full intended body with `status` set to `disabled` and include a useful, non-sensitive `errorMessage`. The message can be shown to the customer administrator. Do not include secrets, tokens, caller data, or internal host details.

Restore service with another full `PUT` that sets `status` to `active`, uses a current nonce/lifetime, and retains the intended registration fields.

### Delete during intentional offboarding

`DELETE /v1/dataSources/{dataSourceId}` removes the registration. Treat this as destructive. Before deletion, verify the customer organization, Service App application ID, data-source ID, and that no published flow still depends on it. Record the offboarding decision, delete the exact ID, and confirm that a subsequent GET no longer returns the resource.

## Implement runtime bearer-token validation

Require a standard `Authorization: Bearer <JWS>` header on every WebSocket HTTP upgrade for both endpoints. Reject authentication failures with HTTP 401 before accepting a WebSocket session or application frame.

Validate in this order:

1. Require exactly the supported Bearer scheme and a nonempty compact JWS. Do not accept a bare token.
2. Parse the protected header and require `alg` to be `RS256`.
3. Read `iss` only far enough to compare it with an allowlist approved for the customer's Webex environment. Do not use an arbitrary unverified issuer to make a network request.
4. Fetch and cache the issuer's verification keys from its documented `oauth2/v2/keys/verificationjwk` endpoint. Apply bounded network timeouts and a defined key-rotation/failure policy.
5. Use `kid` to select the matching verification key. Reject an absent or unknown key ID.
6. Verify the signature before trusting payload claims.
7. Validate `exp` and other applicable time semantics, including a narrowly defined clock-skew policy. Reject expired or not-yet-valid material.
8. Compare `iss`, `aud`, and `sub` with the allowed issuer and the exact registration values.
9. Compare `jti` with the expected current registration nonce.
10. Compare `com.cisco.datasource.url` with the exact registered URL.
11. Compare `com.cisco.datasource.schema.uuid` with `a38a10b7-43e4-4676-a076-a7d6dce9387d`.
12. Compare `com.cisco.org.uuid` with the customer organization that this endpoint/session may serve.
13. Bind the verified organization, data source, subject, and tracking context to the accepted socket. Use that context when scoping the virtual-agent catalog and conversation state.

Never log the compact token, signing material, caller audio, transcripts, or sensitive inputs. Log a bounded reason category such as `expired`, `issuer_mismatch`, `schema_mismatch`, or `org_mismatch` with a safe request correlation value.

Webex supplies the current JWS when it opens a connection. Do not send the Service App OAuth access token on the live socket, and do not replay a token copied from a data-source registration response.

The Java simulator implements a useful starting point: it verifies an RSA signature, future expiration, an issuer allowlist, the presence of `aud`, `sub`, and `jti`, and the URL/schema claims. Harden it before use. The observed sample does not validate the organization claim, accepts a bare token, and does not clearly pin `RS256` or select only the `kid`-matching key.

## Meet production TLS and network requirements

Configure the externally observable transport as follows:

- Publish `wss://` endpoints on the partner-owned domain authorized in the Service App.
- Use TCP 443 unless another port is explicitly approved for the target Webex environment.
- Present a valid server certificate whose subject alternative name matches the endpoint host and whose complete chain is trusted.
- Reject plaintext `ws://`, private, loopback, link-local, malformed, or credential-bearing production URLs.
- Configure proxies, firewalls, WAFs, and load balancers to preserve `Upgrade`, `Connection`, and `Authorization` headers.
- Permit the documented JSON text-frame sizes and application heartbeat traffic.
- Set idle timeouts longer than the expected heartbeat and conversation lifecycle.
- Plan for one concurrent `/v1/va` connection per active conversation.
- Drain instances gracefully during deployment; do not terminate active sockets without a controlled failure path.

Do not build a firewall allowlist from observed test traffic. The public AsyncAPI does not publish stable Webex source IP ranges. Obtain any environment-specific network requirements through the current approved Webex process.

WebSocket authentication uses server-authenticated TLS plus bearer-JWS validation. Optional BYOVA mutual TLS applies to the gRPC variant, not this WebSocket interface.

The Java simulator listens with plaintext by default. Before a Webex-connected test, configure Spring Boot `server.ssl.*` properties or place it behind a correctly configured TLS-terminating ingress. Keep the internal hop and trust boundary appropriate for your deployment.

## Implement `/v1/va`: connection and envelope lifecycle

Accept one Webex-initiated socket for one conversation. Keep the same `conversation_id` on that socket for the welcome exchange and every later turn. Reject attempts to multiplex a second conversation, and do not open a new socket per turn.

Use JSON objects in WebSocket text frames. Put audio bytes in Base64 JSON fields; do not use binary WebSocket frames.

Every application envelope requires these base fields:

| Field | Rule |
| --- | --- |
| `type` | Use `VOICE_VA_REQUEST`, `VOICE_VA_RESPONSE`, `ERROR`, `PING`, or `PONG` |
| `seq` | Use a positive integer. Maintain a monotonically increasing counter independently for each sender. Gaps are allowed; duplicates and regressions are invalid |
| `ts` | Use the message creation time in RFC 3339 date-time format |
| `conversation_id` | Use the stable nonempty conversation identity for this socket |
| `metadata` | Treat as an optional extension object, never as a replacement for required fields |
| `payload` | Include the schema-defined request or response body when the message type requires it |

Do not treat `seq` as a turn number or a request-response correlation ID. Webex owns its outgoing sequence, and your connector owns a separate outgoing sequence. An ordinary response does not echo an incoming request sequence. The application `PONG` is the documented exception: it echoes its triggering `PING` sequence.

The first application message typically looks like this; the timestamp and identifiers are illustrative:

```json
{
  "type": "VOICE_VA_REQUEST",
  "seq": 1,
  "ts": "2026-08-19T10:15:30Z",
  "conversation_id": "conversation-123",
  "payload": {
    "conversation_id": "conversation-123",
    "customer_org_id": "org-456",
    "voice_va_input_type": {
      "event_input": {
        "event_type": "SESSION_START"
      }
    }
  }
}
```

Initialize per-conversation state when you receive `SESSION_START`. Do not require synthetic audio with it. Send a welcome reply if the selected virtual-agent design requires one.

A logical partner reply can contain zero or more `PARTIAL` messages, zero or more `CHUNK` messages, and exactly one `FINAL`. `FINAL` completes that reply only; keep the socket open for the next turn. On a transport or protocol failure, clean up the session deterministically. Webex does not reconnect, resume, or replay an existing conversation after the socket fails.

## Handle Webex requests and partner responses

### Parse requests from Webex

Require `conversation_id`, `customer_org_id`, and exactly one `voice_va_input_type` wrapper in every `VoiceVARequest` payload. Ensure the payload `conversation_id` matches the envelope and socket.

The input wrapper contains one of:

| Wrapper | Required content | Purpose |
| --- | --- | --- |
| `audio_input` | `encoding` and `sample_rate_hertz`; `caller_audio_b64` when audio bytes are present | Deliver caller audio |
| `dtmf_input` | Ordered `dtmf_events` array | Deliver a completed DTMF sequence |
| `event_input` | `event_type`; optional `name` and open `parameters` | Deliver session, no-input, DTMF-start, or custom events |

The request can also include `virtual_agent_id`, `allow_partial_responses`, `vendor_specific_config`, and an `additional_info` string map. Treat optional/unknown business configuration safely; do not place credentials or required protocol state in it.

The schema lists `UNSPECIFIED_FORMAT`, `LINEAR16_FORMAT`, `MULAW_FORMAT`, and `ALAW_FORMAT` as encoding enum values. Do not assume that every enum combination is qualified end to end. Implement the current production media profile described below.

### Build partner responses

Return a schema-valid `VOICE_VA_RESPONSE` envelope with your own sequence, timestamp, and the connection's conversation ID. For example:

```json
{
  "type": "VOICE_VA_RESPONSE",
  "seq": 1,
  "ts": "2026-08-19T10:15:31Z",
  "conversation_id": "conversation-123",
  "payload": {
    "prompts": [
      {
        "audio_content_b64": "<base64-encoded raw-mu-law-bytes>",
        "is_barge_in_enabled": true
      }
    ],
    "input_mode": "INPUT_VOICE_DTMF",
    "input_sensitive": false,
    "response_type": "CHUNK"
  }
}
```

Follow this field contract:

| Response field | Use |
| --- | --- |
| `prompts` | Return text and/or inline `audio_content_b64`. Use inline audio in implementation examples; do not depend on `audio_uri` alone because the current `Prompt` alternatives require text or inline audio |
| `output_events` | Return schema-defined speech-boundary, no-input/no-match, transfer, custom, or session-end events |
| `input_sensitive` | Mark sensitive automated-agent output when applicable |
| `input_mode` | Select `INPUT_VOICE_MODE_UNSPECIFIED`, `INPUT_VOICE`, `INPUT_EVENT_DTMF`, or `INPUT_VOICE_DTMF` |
| `input_handling_config` | Configure DTMF collection and the public speech timers |
| `session_transcript` | Return transcript content when applicable; publication depends on customer organization configuration |
| `session_summary` | Treat as a schema field, not as a supported replacement for the Webex handoff transcript |
| `disable_prompt_cancellation` | Prevent a partial automated-agent reply from being canceled by a later partner reply; do not confuse it with caller barge-in |
| `response_type` | Use `PARTIAL`, `CHUNK`, or `FINAL`; include exactly one `FINAL` per logical reply |

If you set speech timers, use only the current public fields: `max_speech_timeout_msec`, `complete_timeout_msec`, and `incomplete_timeout_msec`. Do not emit an internal or sample-only `no_input_timeout_msec` field.

## Audio format and chunking

Use this qualified media profile in both directions:

| Property | Required value |
| --- | --- |
| Encoding | Raw G.711 mu-law, also called PCMU or u-law |
| Sample rate | 8000 Hz |
| Channels | One, mono |
| Sample size | 8 bit, one byte per sample |
| Container | None; omit WAV, RIFF, and every other container header |
| JSON representation | Base64 string |
| Caller field | `audio_input.caller_audio_b64` |
| Partner field | `prompts[].audio_content_b64` |
| Recommended raw response chunk | 8000-16000 bytes, approximately 1-2 seconds |
| Minimum raw response chunk | 320 bytes, approximately 40 milliseconds |
| Maximum raw response chunk | 32 KB |

Send each partner audio chunk as soon as your generator produces it. Do not pace chunks at playback speed, add leading silence, or buffer the complete response before sending. Webex buffers and paces the audio to the caller.

Calculate chunk limits from decoded raw bytes, not the larger Base64 string. Validate incoming encoding and sample rate before decoding/processing. If the media is unsupported, send a bounded `unsupported_media` error when possible and terminate the invalid session according to your state machine.

Ignore older sample material that describes WAV output or asks you to prepend a WAV header. The Java simulator's non-chunk audio path is legacy demo behavior and does not meet the current production media profile.

## Map events, barge-in, DTMF, transfer, and session end

Implement only the directions defined by the public contract:

| Input or event | Direction | Connector behavior |
| --- | --- | --- |
| `SESSION_START` | Webex to partner | Initialize the conversation and optionally send a welcome reply |
| `audio_input` | Webex to partner | Process caller media and own speech-boundary/end-of-turn detection |
| `dtmf_input` | Webex to partner | Preserve and process the ordered DTMF digits |
| `START_OF_DTMF` | Webex to partner | Treat as the start/interruption signal for DTMF collection |
| `NO_INPUT` | Both directions | Interpret from direction and state: Webex can notify you; your connector can report the outcome |
| `START_OF_INPUT` | Partner to Webex | Tell Webex that caller speech has started; use it for speech interruption |
| `END_OF_INPUT` | Partner to Webex | Tell Webex that the caller utterance has ended |
| `NO_MATCH` | Partner to Webex | Report detected input that the virtual agent could not understand or match |
| `TRANSFER_TO_AGENT` | Partner to Webex | Request handoff; Webex executes the path configured in the flow |
| `CUSTOM_EVENT` | Both directions | Exchange a provider/customer-agreed named event and metadata; do not assume generic business semantics |
| `SESSION_END` | Both directions | End the virtual-agent leg and close/clean up in the correct order |

### Implement caller interruption

There is no `BARGE_IN` event in the public WebSocket schema. To allow voice interruption:

1. Set `prompts[].is_barge_in_enabled` to `true` for an interruptible prompt.
2. Continue processing caller audio while appropriate for the turn.
3. Detect caller speech in your connector.
4. Send `START_OF_INPUT` when speech begins.
5. Stop/cancel partner generation and maintain state according to your design and the Webex prompt behavior.
6. Send `END_OF_INPUT` when your end-of-turn detector completes the caller utterance.

Keep `disable_prompt_cancellation` separate: that field controls whether a later partner reply can cancel an earlier partial automated-agent reply. It does not enable or disable caller barge-in.

### Implement DTMF

Set `input_mode` to `INPUT_EVENT_DTMF` or `INPUT_VOICE_DTMF` when you want DTMF. Use `input_handling_config.dtmf_config` to set `inter_digit_timeout_msec`, `termchar`, and `dtmf_input_length` as needed. Process the exact ordered values in `dtmf_events`.

The DTMF enum contains `DTMF_EVENT_UNSPECIFIED`, digits zero through nine, A through D, star, and pound using the `DTMF_DIGIT_*` names. Do not teach the Java simulator's digit-to-action mapping as protocol behavior; it is replaceable demo logic.

### Transfer or end the session

To request handoff, include `TRANSFER_TO_AGENT` in `output_events`. Configure the transfer/error path in Flow Designer; closing a WebSocket by itself is not a transfer instruction.

To end from the partner, send `SESSION_END` in a valid response and then complete the close sequence after applicable output is handled. On an orderly Webex-initiated end, process the single inbound `SESSION_END`, release upstream resources, clear all per-conversation state, and close cleanly.

Transcript publication is configuration dependent. Sending `session_transcript` does not itself enable storage or display, and `session_summary` is not a supported substitute for the accumulated Webex handoff transcript.

## Handle heartbeats, errors, and closure

Implement the schema-level heartbeat even if your WebSocket library also handles protocol control frames. An application `PING` or `PONG` is a JSON envelope, not a WebSocket control frame.

When you receive an application `PING`, promptly return a schema-valid `PONG` with the same `seq` and `conversation_id`, plus an RFC 3339 timestamp. Keep heartbeat state separate from your ordinary outbound response sequence because PONG uses the documented echo rule.

Return an `ERROR` envelope only with these public codes:

- `unauthorized`
- `bad_request`
- `unsupported_media`
- `upstream_error`
- `rate_limit`
- `timeout`

Include the base envelope fields, the code, a numeric HTTP-style `status`, and a bounded `detail`. For example:

```json
{
  "type": "ERROR",
  "seq": 12,
  "ts": "2026-08-19T10:17:04Z",
  "conversation_id": "conversation-123",
  "code": "upstream_error",
  "status": 502,
  "detail": "The virtual-agent runtime did not return a usable response."
}
```

Do not put a bearer token, credential, raw audio, transcript, sensitive input, stack trace, or internal URL in `detail`.

Treat a malformed known envelope, duplicate/regressed sequence, conversation mismatch, heartbeat timeout, capacity failure, unexpected close, or network failure as terminal for the existing conversation. Return a bounded error when the connection/state still permits it, close deterministically, and clear state. Do not retain audio in anticipation of a replay; Webex does not resume that socket.

The Java simulator currently logs an application `PING` without sending the required application `PONG`. Its protocol-level `handlePongMessage` method does not fill this gap. Add and test the JSON heartbeat before connecting Webex.

## Implement `/v1/listVirtualAgents`

Use a separate WebSocket handler for catalog discovery. Accept one bare request object, return one bare response object, and close cleanly after the short exchange. Do not wrap either object in a `/v1/va` envelope.

Request:

```json
{
  "customer_org_id": "org-456",
  "is_default_virtual_agent_enabled": false
}
```

`customer_org_id` is required. `is_default_virtual_agent_enabled` is optional.

Response:

```json
{
  "virtual_agents": [
    {
      "id": "agent-789",
      "name": "Example virtual agent",
      "description": "Handles example customer-service calls"
    }
  ]
}
```

`virtual_agents` is required. Every entry requires `id` and `name`; `description` is optional. The selected ID later appears as `virtual_agent_id` in `/v1/va` requests.

Bind the request to the authenticated organization from the verified JWS. Reject an organization mismatch instead of trusting `customer_org_id` by itself. Return only agents that the customer may use. Replace the simulator's hard-coded list with your tenant-aware catalog and add tests for an empty authorized catalog, unknown tenants, and cross-tenant requests.

## Configure Contact Center and the call flow

After the provider verifies the data-source registration, ask the customer administrator to configure Webex Contact Center:

1. Sign in to Control Hub.
2. Navigate to **Contact Center** > **Integrations** > **Features**.
3. Create the Contact Center AI/CCAI configuration used for the virtual agent.
4. Select the same authorized Service App and WebSocket data source that the provider registered.
5. Select the intended virtual agent returned from `/v1/listVirtualAgents` when the configuration presents the catalog.
6. Save the configuration.
7. Open Flow Designer.
8. Add a **Virtual Agent Voice** activity.
9. Select the CCAI configuration.
10. Connect the success, error, transfer, and custom-event paths required by the customer experience. Do not assume a transport `CUSTOM_EVENT` has a generic flow or CRM effect; configure and test the agreed behavior.
11. Validate and publish the flow.
12. Navigate to **Contact Center** > **Channels** > **Entry Point**.
13. Map the entry point to the published flow.
14. Place a controlled test call.

Expected result: Webex resolves the WebSocket-schema data source, opens a secure socket to the provider, presents a bearer JWS, sends `SESSION_START`, and continues all virtual-agent turns on that socket.

Follow the current [BYOVA overview](https://developer.webex.com/webex-contact-center/docs/bring-your-own-virtual-agent) for the generic Control Hub provisioning sequence, but use the dedicated WebSocket guide and schema for transport fields, media, events, and schema ID.

## Run the Java simulator locally

The simulator under `simulators/byova-websocket-json-java/` is a learning and smoke-test aid. It uses Spring Boot 4, Java 21, JSON text frames, prerecorded prompts, and port 8086. It is not a conformance test or production-ready connector.

### Start a loopback-only instance

From the repository root:

```bash
cd bring-your-own/virtual-agent/web-socket-interface/simulators/byova-websocket-json-java
java -version
AUTH_ENABLED=false ./mvnw spring-boot:run
```

Wait for `Tomcat started on port 8086`. Keep this authentication-disabled instance on loopback only.

In another terminal, test the catalog endpoint:

```bash
wscat -c ws://localhost:8086/v1/listVirtualAgents
```

Send:

```json
{"customer_org_id":"org-456","is_default_virtual_agent_enabled":false}
```

Verify that the response contains a `virtual_agents` array. Treat its entries as hard-coded fixtures, not a tenant catalog.

Open the conversation endpoint:

```bash
wscat -c ws://localhost:8086/v1/va
```

Send the schema-valid `SESSION_START` example from this guide. Verify that the sample attempts to return its welcome prompt. The current sample response can fail the public AsyncAPI because its response builders omit required `seq`, `ts`, and `conversation_id`; fix those fields before using the output as a contract test.

### Build the sample

Use the included wrapper:

```bash
./mvnw clean package
java -jar target/byova-websocket-json-java-1.0.0.jar
```

Do not assume Docker support. The current module does not include a Dockerfile or Compose definition.

### Enable authentication for a deployed test

Keep `auth.enabled=true` and supply at least the environment-approved issuer configuration plus:

```properties
auth.datasource-url=wss://byova.example.com
auth.datasource-schema-uuid=a38a10b7-43e4-4676-a076-a7d6dce9387d
```

Match `auth.datasource-url` to the exact URL claim generated from your registration. Replace all shipped placeholders. Do not paste a bearer token into source or a shared shell history; use a secure test harness. Add production TLS before Webex connects.

Use the sample as a map to these extension points:

- Replace prerecorded and echo audio with the partner speech/agent runtime.
- Replace the hard-coded agent list with a tenant-scoped catalog.
- Isolate audio, DTMF, sequence, upstream, and lifecycle state per connection.
- Add strict AsyncAPI and state-machine validation.
- Add schema-valid heartbeat, error, transfer, session-end, and close behavior.
- Add bounded queues, upstream timeouts, backpressure, graceful draining, and safe metrics/logging.

## Validate end to end

Run staged tests and record the observable result for every scenario.

### Stage 1: schema and unit tests

1. Validate both AsyncAPI files from the public schema directory.
2. Reject missing/extra required envelope fields and invalid enums.
3. Verify independent Webex and partner sequence counters, permitted gaps, and rejected duplicates/regressions.
4. Verify payload/envelope conversation equality and one conversation per socket.
5. Verify zero or more `PARTIAL`/`CHUNK` messages followed by exactly one `FINAL` per logical reply.
6. Verify raw mu-law media, decoded chunk limits, and absence of WAV/RIFF headers.
7. Verify that the list endpoint accepts/returns bare objects rather than conversation envelopes.

Expected result: every generated message validates against the current public schema, and invalid input produces a bounded failure without corrupting another session.

### Stage 2: security and transport tests

Test a valid bearer, then separately test missing Bearer syntax, malformed token, expired token, wrong or unapproved issuer, wrong algorithm, unknown `kid`, bad signature, audience mismatch, subject mismatch, nonce/JTI mismatch, URL mismatch, schema mismatch, and organization mismatch.

Test the production certificate chain/hostname, port, proxy upgrade behavior, forwarded `Authorization`, maximum message handling, application PING/PONG, idle timeout, and orderly/unexpected close.

Expected result: valid Webex material upgrades successfully; every invalid case fails before the socket is accepted and logs only a safe reason category.

### Stage 3: control-plane tests

1. Confirm that the customer Full Admin sees the intended Service App developer, scopes, domain, and WebSocket schema.
2. Confirm that a customer-specific Service App token can register/list/get/update the intended organization's resources.
3. Confirm that a personal Try It token fails.
4. Register with string `schemaId`, numeric `tokenLifetimeMinutes`, an authorized URL, and a unique nonce.
5. Retrieve and verify active state.
6. Rotate the nonce with a full PUT before expiry and verify the result.
7. Disable and restore a non-production registration.
8. Confirm the documented deauthorization/offboarding outcome in a controlled tenant.

Expected result: no management token or data source crosses an organization boundary, and rotation completes before the runtime credential expires.

### Stage 4: call tests

Place controlled calls that cover:

- Initial `SESSION_START` and a valid welcome reply
- Multiple voice turns on one socket
- Incremental audio and exactly one `FINAL`
- Voice barge-in using `is_barge_in_enabled` and `START_OF_INPUT`
- Ordered DTMF with `START_OF_DTMF` and `dtmf_input`
- `NO_INPUT` and `NO_MATCH`
- Agreed `CUSTOM_EVENT` behavior in both directions
- `TRANSFER_TO_AGENT` through the configured flow path
- Webex-initiated and partner-initiated `SESSION_END`
- Upstream timeout, rate limit, malformed frame, heartbeat timeout, load shedding, and connection drop

Expected result: the intended Flow Designer path runs, every terminal path cleans connector state, and a failed conversation is not resumed or replayed.

### Stage 5: catalog, transcript, load, and operations tests

Verify that `/v1/listVirtualAgents` returns only agents authorized for the JWS-bound organization and closes after the response. If transcript publication is configured, verify only the intended transcript behavior; do not assume that `session_summary` appears downstream.

Load-test one socket per active call, bounded queues, upstream concurrency, horizontal scale, instance draining, key refresh, and credential rotation. Verify alerts for authentication failure rates, heartbeat failures, abnormal close reasons, first-audio latency, turn latency, upstream health, and capacity rejection.

Expected result: the connector remains bounded and tenant-isolated under its target load, and operators can identify a failing layer without logging sensitive content.

## Prepare for production

Close every known sample-to-production gap before onboarding a customer:

| Area | Current simulator behavior | Production action |
| --- | --- | --- |
| TLS | Plaintext by default | Terminate valid `wss` TLS on the authorized host and test the complete chain |
| Bearer validation | Can be disabled; checks only part of the recommended policy | Require Bearer, pin RS256, select `kid`, verify all claims including organization, and define JWKS rotation/failure behavior |
| Response envelope | Builders can omit `seq`, `ts`, and `conversation_id` | Generate every required field with per-connection state |
| Schema/state validation | DTO parsing does not enforce the complete schema or lifecycle | Validate known envelopes, enums, sequence, state, and conversation identity |
| Heartbeat | Logs application PING without returning PONG | Implement and monitor application PING/PONG |
| Error/close | Some failures are only logged; cleanup is incomplete | Return bounded schema errors when possible, close deterministically, and clear all state |
| Catalog | Hard-coded entries; lifecycle is incomplete | Query a tenant-scoped store and close the request-response socket cleanly |
| Audio | Legacy non-chunk path prepends WAV; prompts are fixtures | Use raw mu-law only, stream qualified chunks, and integrate the real speech stack |
| Prompt fields | Does not cover every current field | Support current fields such as `disable_prompt_cancellation` when needed |
| DTMF | Demo README/code mappings can disagree | Replace digit actions with tested product behavior |
| Concurrency | Some mutable state is held by singleton services | Isolate all state per conversation and remove it on every terminal path |
| Logging | Some payload/event data is logged | Redact tokens, audio, transcripts, sensitive input, and customer configuration |
| Tests | No complete automated conformance suite | Add schema, contract, load, failure, and end-to-end call tests |

Also implement these operational controls:

- Bound every inbound/outbound queue and define overload behavior.
- Apply timeouts and cancellation to ASR, agent/LLM, TTS, catalog, and JWKS dependencies.
- Scale horizontally without shared mutable conversation state; use routing/stickiness only as required by your state model.
- Drain deployments gracefully and preserve existing sockets until completion or a controlled timeout.
- Separate Service App OAuth renewal from data-source nonce/runtime-token rotation.
- Track connection attempts, successful upgrades, categorized authentication failures, active connections, first-audio latency, turn latency, heartbeat round-trip/timeout, protocol error codes, close reasons, upstream health, and controlled capacity rejection.
- Correlate safely with `conversation_id` and bounded organization/data-source identifiers. Never emit bearer tokens, raw audio, transcripts, or sensitive caller input.

## Troubleshoot common failures

| Symptom | Likely layer | Check | Expected resolution |
| --- | --- | --- | --- |
| HTTP 401 during upgrade | Runtime JWS validation | Bearer syntax, expiry/time, approved issuer/JWKS, RS256, `kid`, signature, `aud`, `sub`, `jti`, URL, schema `a38a...`, and org binding; replace sample placeholders | A valid current Webex JWS upgrades; invalid material remains rejected |
| REST API returns 401/403 | Service App OAuth/control plane | Use the customer-specific Service App access token, not Try It; confirm authorization and read/write scopes | Data Sources calls succeed only for the authorized org |
| TLS or upgrade fails | Network/TLS | Public DNS, `wss`, port 443, certificate name/chain, forwarded Upgrade/Connection/Authorization, WAF rules | HTTP upgrades to WebSocket without weakening authentication |
| Connection opens but no welcome | `/v1/va` state | First frame is a valid `VOICE_VA_REQUEST` with `SESSION_START`, sequence typically 1, matching conversation IDs, and no required synthetic audio | Connector initializes and sends one valid logical welcome reply |
| Webex closes around heartbeat | Liveness | Return application PONG echoing PING sequence; do not rely on control frames; inspect proxy idle timeout | Heartbeats remain timely throughout the conversation |
| Audio is distorted | Media | Decode as raw mu-law/8 kHz/mono/8-bit; verify Base64 and byte count; remove WAV/RIFF | Caller and partner audio play at the expected rate |
| Audio is delayed | Generation/pacing | Send 8-16 KB chunks as generated; remove real-time pacing, leading silence, and full-response buffering | First audio and subsequent chunks arrive promptly |
| Barge-in fails | Event/turn handling | Set `is_barge_in_enabled`; emit `START_OF_INPUT`; do not wait for a nonexistent `BARGE_IN` event | Caller speech interrupts only intended prompts |
| DTMF is missing or reordered | Input configuration | Set an appropriate input mode/config; process `START_OF_DTMF` and ordered `dtmf_events`; ignore demo action mappings | The exact entered sequence reaches partner logic |
| Turn never completes | Response finality/state | Send exactly one `FINAL`; inspect speech-end detection, upstream timeout, and sequence regression | Each logical reply completes once and socket remains usable |
| Catalog is empty or cross-tenant | List endpoint/auth | Use bare list objects; compare requested org with verified JWS org; replace hard-coded catalog | Only authorized agents are returned for that customer |
| Transfer does not occur | Event/flow | Send `TRANSFER_TO_AGENT`; verify the Virtual Agent Voice transfer path; do not rely on close alone | Webex executes the configured handoff |
| Transcript is absent | Organization configuration | Verify transcript publication configuration; do not assume sending transcript enables it or that summary substitutes for it | Observed behavior matches explicit customer configuration |
| Calls fail near data-source expiry | Runtime registration | Inspect data-source expiry; rotate nonce/full registration before expiry | New handshakes use current runtime material |
| Calls fail after OAuth expiry | Management automation | Refresh the Service App access token; do not confuse it with data-source JWS rotation | REST maintenance resumes without changing live-wire auth design |
| Sample output fails schema | Simulator gap | Add `type`, positive partner `seq`, RFC 3339 `ts`, stable `conversation_id`, valid payload, heartbeat, and current response fields | Sample-generated frames validate against public AsyncAPI |
| Custom event unexpectedly ends or does nothing | Contract/flow mapping | Verify agreed direction, name/metadata, state transition, and explicit Flow Designer path | The event performs only the customer/provider-agreed behavior |

## Glossary

| Term | Meaning in this guide |
| --- | --- |
| BYOVA | Bring Your Own Virtual Agent: the integration that connects a partner-hosted voice virtual agent to Webex Contact Center |
| BYODS | Bring Your Own Data Source: the control plane used to authorize a provider, bind a schema and endpoint, and create runtime trust; it does not transport conversation audio |
| Service App | An organization-authorized Webex machine account whose OAuth token manages Data Sources API resources |
| Data source | A customer-organization registration containing the WebSocket schema, endpoint URL, JWT claim inputs, lifetime, and status |
| Data Exchange Domain | The partner-owned domain approved by the customer administrator for data-source URLs |
| Data Exchange Schema | The contract selected in the Service App and data source; for this transport its ID is `a38a10b7-43e4-4676-a076-a7d6dce9387d` |
| JWS | The signed bearer token that Webex presents during the WebSocket HTTP upgrade and the partner validates |
| CCAI configuration | The Contact Center AI integration configuration that selects the authorized Service App/data source for a flow |
| Virtual Agent Voice | The Flow Designer activity that invokes the configured voice virtual agent and routes its outcomes |
| Logical reply | A partner response sequence containing optional `PARTIAL`/`CHUNK` messages and exactly one `FINAL` |
| Application heartbeat | JSON `PING` and `PONG` envelopes defined by the BYOVA schema; these are distinct from WebSocket protocol control frames |

## Reference links

- [BYOVA over WebSocket](https://developer.webex.com/mcp/docs/bring-your-own-virtual-agent-over-websocket)
- [Bring Your Own Virtual Agent overview](https://developer.webex.com/webex-contact-center/docs/bring-your-own-virtual-agent)
- [Bring Your Own Data Source](https://developer.webex.com/webex-contact-center/docs/bring-your-own-data-source-cc)
- [Data Sources API](https://developer.webex.com/admin/docs/api/v1/data-sources)
- [Service Apps](https://developer.webex.com/create/docs/service-apps)
- [BYOVA WebSocket AsyncAPI directory](https://github.com/webex/dataSourceSchemas/tree/main/Services/VoiceVirtualAgent_WebSocket/a38a10b7-43e4-4676-a076-a7d6dce9387d/AsyncApiSpec)
- [Conversation schema: `VoiceVirtualAgent_WsSchema.json`](https://github.com/webex/dataSourceSchemas/blob/main/Services/VoiceVirtualAgent_WebSocket/a38a10b7-43e4-4676-a076-a7d6dce9387d/AsyncApiSpec/VoiceVirtualAgent_WsSchema.json)
- [Catalog schema: `VoiceVirtualAgent_WsListVASchema.json`](https://github.com/webex/dataSourceSchemas/blob/main/Services/VoiceVirtualAgent_WebSocket/a38a10b7-43e4-4676-a076-a7d6dce9387d/AsyncApiSpec/VoiceVirtualAgent_WsListVASchema.json)
- [CiscoDevNet BYOVA WebSocket sample](https://github.com/CiscoDevNet/webex-contact-center-provider-sample-code/tree/main/bring-your-own/virtual-agent/web-socket-interface)

When implementation behavior and prose differ, validate against the current public AsyncAPI and dedicated BYOVA over WebSocket page, then update the connector and its tests together.
