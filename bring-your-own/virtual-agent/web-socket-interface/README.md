# Build a BYOVA connector over WebSocket

Use this guide to implement, register, configure, and validate a Bring Your Own Virtual Agent (BYOVA) connector for Webex Contact Center. The connector exposes two partner-hosted WebSocket endpoints. Bring Your Own Data Source (BYODS) provides the control plane that binds the customer organization, connector URL, schema, and runtime trust.

Use the [BYOVA over WebSocket guide](https://developer.webex.com/mcp/docs/bring-your-own-virtual-agent-over-websocket) and the [public AsyncAPI specifications](https://github.com/webex/dataSourceSchemas/tree/main/Services/VoiceVirtualAgent_WebSocket/a38a10b7-43e4-4676-a076-a7d6dce9387d/AsyncApiSpec) as the source of truth for the wire contract. The schema ID for this transport is `a38a10b7-43e4-4676-a076-a7d6dce9387d`.

## BYOVA connector overview

Implement these endpoints on the domain that the customer authorizes:

| Endpoint | Purpose | Connection model | Message form |
| --- | --- | --- | --- |
| `/v1/va` | Exchange conversation events, caller audio, virtual-agent responses, dual-tone multifrequency (DTMF), errors, and heartbeats | One long-lived WebSocket connection for one `conversation_id` | Enveloped `VOICE_VA_REQUEST`, `VOICE_VA_RESPONSE`, `ERROR`, `PING`, and `PONG` JSON objects |
| `/v1/listVirtualAgents` | Return the virtual agents available to a customer organization | A separate, short request-response WebSocket connection | Bare `ListVARequest` and `ListVAResponse` JSON objects |

BYODS registration is a REST control-plane operation. Live conversations use WebSocket connections initiated by Webex. Keep their credentials separate: use the customer-specific Service App access token for Data Sources API calls, and validate the data-source JSON Web Signature (JWS) that Webex presents on each WebSocket upgrade.

## Before you begin

Confirm these requirements:

- Obtain access to create a Service App in [Webex for Developers](https://developer.webex.com/).
- Identify a Full Admin for each customer Webex organization. The Full Admin authorizes the Service App and configures Webex Contact Center.
- Confirm through your Webex channel that BYOVA over WebSocket is available for the target organization.
- Host a partner-owned public DNS domain with a valid, hostname-matching TLS certificate.
- Make both WebSocket paths reachable through `wss://`, typically on TCP port 443.
- Ensure every network component on the route preserves the HTTP WebSocket upgrade and `Authorization` header and permits long-lived JSON text-frame connections.
- Install JDK 21 if you will run the Java simulator. The repository includes the Maven wrapper used by this guide.
- Install a WebSocket test client if you will run the loopback smoke test.

The public contract does not prescribe a programming language, WebSocket library, web framework, proxy, hosting platform, or deployment model. Choose an implementation that can satisfy the authentication, message, media, state, and connection requirements in the AsyncAPI.

## Complete the onboarding flow

Use this sequence for every customer organization:

| Step | Owner | Action | Result |
| --- | --- | --- | --- |
| 1 | Provider | Implement and secure `/v1/va` and `/v1/listVirtualAgents` | The connector is ready for Webex-initiated connections |
| 2 | Provider | Create a Service App with the data-source scopes, WebSocket schema, and Data Exchange Domain | The app describes the permitted data exchange |
| 3 | Customer Full Admin | Authorize the Service App in Control Hub | Webex creates an organization-specific machine account |
| 4 | Provider | Retrieve and protect the organization's Service App token pair | The provider can manage that organization's data source |
| 5 | Provider | Register and verify the WebSocket data source | Webex has the URL and trust configuration |
| 6 | Customer administrator | Create the Contact Center AI configuration | Contact Center can select the registered integration |
| 7 | Customer flow author | Configure and publish the flow, then map an entry point | Test calls can enter the BYOVA flow |
| 8 | Provider and customer | Run an end-to-end call test | Authentication, media, events, and configured outcomes are verified |

Manage two renewal processes independently: refresh the Service App OAuth credentials used for REST management, and rotate the data-source registration before its runtime JWS expires.

## Create the Service App

Create the app as the provider developer:

1. Sign in to Webex for Developers and open **My Webex Apps**.
2. Select **Create a New App**, then select **Create Service App**.
3. Enter the app name, description, logo, and contact details. Give the customer enough information to identify the provider and integration.
4. Store the client secret in a secret manager when Webex displays it.
5. Under **Bring Your Own Datasource Settings**, select these scopes:
   - `spark-admin:datasource_read`
   - `spark-admin:datasource_write`
6. Under **Data Exchange Schema**, select **VoiceVirtualAgent_WebSocket**, the WebSocket virtual-agent schema with the `web-socket` protocol for a Service App.
7. Enter the partner-owned **Data Exchange Domain**, such as `byova.example.com`. Enter the domain only: omit the scheme, port, path, and wildcard characters.
8. Save the Service App.

The host used in each data-source registration must fall within the authorized Data Exchange Domain. Record the application ID, schema ID, domain, and requested scopes in your onboarding system, but store the client secret separately.

For your own Webex organization, use **Request Admin Authorization** to make the app visible to its administrators. For a customer organization not affiliated with the developer, follow the current discovery, App Hub, and review rules in [Service Apps](https://developer.webex.com/create/docs/service-apps). Do not assume that saving the app makes it visible to every customer.

## Authorize the Service App in Control Hub

Ask a Full Admin in the customer organization to complete these steps:

1. Sign in to Control Hub.
2. Navigate to **Management** > **Apps** > **Service Apps**.
3. Open the provider's Service App.
4. Verify the developer, purpose, requested scopes, Data Exchange Domain, and Data Exchange Schema.
5. Select **Authorize**, then save the change.

![Service App authorization page in Webex Control Hub](https://images.contentstack.io/v3/assets/bltd74e2c7e18c68b20/blte2e64bb836a5ddb6/1.png)

*Authorize the provider Service App for the customer organization. See the [BYOVA provisioning guide](https://developer.webex.com/webex-contact-center/docs/bring-your-own-virtual-agent) for the current Control Hub interface.*

Authorization creates a machine account in that customer organization. Confirm that the organization appears under the Service App's **Org Authorizations** section.

If the provider later changes the app's scopes, exchange domain, or schema, follow the reauthorization behavior documented on the Service Apps page. Deauthorization deletes the machine account and invalidates its tokens. Treat it as an offboarding event, not a routine token refresh.

## Retrieve and store organization-specific tokens

Retrieve the access and refresh token pair for the authorized organization from the Service App's **Org Authorizations** section, or automate retrieval through the documented token endpoint. Store credentials under an organization-specific tenant key.

| Credential | Use |
| --- | --- |
| Service App access token | Call Data Sources REST operations for the organization that authorized the app |
| Service App refresh token | Renew that Service App OAuth access |
| Runtime data-source JWS | Authenticate an inbound Webex WebSocket upgrade |

Do not use the Service App access token as the runtime WebSocket credential. Do not use a Developer Portal **Try It** personal token to manage customer data sources.

For automated token retrieval, construct this API request:

| Request part | Value |
| --- | --- |
| Method | `POST` |
| Full URL | `https://webexapis.com/v1/applications/{appId}/token` |
| Authorization header | `Authorization: Bearer <personal access token or integration token with spark:applications_token>` |
| Content type | `Content-Type: application/json` |

Request body:

```json
{
  "clientId": "<service-app-client-id>",
  "clientSecret": "<service-app-client-secret>",
  "targetOrgId": "<authorized-customer-organization-id>"
}
```

Replace `{appId}` with the Service App application ID. Expect the access and refresh token pair for `targetOrgId`; parse the response according to the live [Service Apps](https://developer.webex.com/create/docs/service-apps) reference. Protect the request body and response from logs, traces, error messages, and source control. Inspect the actual expiry values and refresh before they lapse.

## Register the WebSocket data source

Register one data source for each customer organization with that organization's Service App access token.

### Define the registration

Use this JSON body as the implementation template:

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

Replace every example value.

| Field | Type | Requirement |
| --- | --- | --- |
| `schemaId` | String | Use `a38a10b7-43e4-4676-a076-a7d6dce9387d` |
| `url` | String | Use the public `wss://` base URL on the authorized domain; serve `/v1/va` and `/v1/listVirtualAgents` on this host |
| `audience` | String | Set a stable connector audience and require the same value in JWS `aud` |
| `subject` | String | Set a stable service subject and require the same value in JWS `sub` |
| `nonce` | String | Generate a unique, unpredictable value for this organization and each later rotation; require it in JWS `jti` |
| `tokenLifetimeMinutes` | Number | Set a value from 1 through 1440 and rotate the registration before expiry |

Use the current field names and types. In particular, `schemaId` is a string and `tokenLifetimeMinutes` is a number. Do not copy older BYODS examples that use a `schemaId` array or `tokenLifeMinutes`.

### Create the data source

Construct this API request:

| Request part | Value |
| --- | --- |
| Method | `POST` |
| Full URL | `https://webexapis.com/v1/dataSources` |
| Authorization header | `Authorization: Bearer <customer-specific-Service-App-access-token>` |
| Content type | `Content-Type: application/json` |
| Body | The complete registration JSON shown above |

On success, retain the returned data-source `id` with the customer record. Also inspect the returned status, organization ID, application ID, schema ID, URL, and token metadata. Accept additive response fields so that automation does not depend on an exact example response.

Do not save a returned `jwsToken` for replay on future WebSocket connections. Webex presents current runtime authorization when it opens a socket. A JWS returned by the REST API can help inspect registration claims, but it is not a provider credential to send back to Webex.

### Retrieve and verify the data source

Construct this verification request:

| Request part | Value |
| --- | --- |
| Method | `GET` |
| Full URL | `https://webexapis.com/v1/dataSources/{dataSourceId}` |
| Authorization header | `Authorization: Bearer <customer-specific-Service-App-access-token>` |
| Body | None |

Replace `{dataSourceId}` with the ID returned by the create operation. Verify that:

- `status` is `active`.
- `schemaId`, `orgId`, and `applicationId` match the intended schema, organization, and Service App.
- The registered URL is the expected `wss://` URL on the authorized domain.
- The JWS claim set contains the configured `aud`, `sub`, and nonce in `jti`, plus matching `com.cisco.datasource.url`, `com.cisco.datasource.schema.uuid`, and `com.cisco.org.uuid` values.
- The `iat` and `exp` values provide the requested lifetime and enough time for planned rotation.

Decoding a JWS payload does not validate its signature. Treat decoded claims as inspection data until signature verification succeeds. Use the live [Data Sources API](https://developer.webex.com/admin/docs/api/v1/data-sources) for the current request and response schema.

## Maintain and offboard the data source

Use the full `https://webexapis.com` endpoint in every implementation:

| Operation | Method | Full URL | Body | Expected response | Verify |
| --- | --- | --- | --- | --- | --- |
| Register | `POST` | `https://webexapis.com/v1/dataSources` | Complete registration | Created data-source record with an `id` | Retain the ID, then perform the create/retrieve checks above |
| List | `GET` | `https://webexapis.com/v1/dataSources` | None | Data-source collection visible to the Service App | Results are scoped to the intended organization and application |
| Retrieve | `GET` | `https://webexapis.com/v1/dataSources/{dataSourceId}` | None | One data-source record | Schema, organization, application, URL, status, and token claims pass the checks above |
| Update, rotate, disable, or restore | `PUT` | `https://webexapis.com/v1/dataSources/{dataSourceId}` | Complete intended registration | Updated data-source record | A subsequent `GET` shows the intended configuration, nonce, expiry, and status |
| Delete | `DELETE` | `https://webexapis.com/v1/dataSources/{dataSourceId}` | None | Successful deletion response | A subsequent `GET` no longer returns the resource |
| List schemas | `GET` | `https://webexapis.com/v1/dataSources/schemas` | None | Available data-source schema collection | The collection contains WebSocket schema ID `a38a10b7-43e4-4676-a076-a7d6dce9387d` |
| Retrieve a schema | `GET` | `https://webexapis.com/v1/dataSources/schemas/{schemaId}` | None | One schema record | The returned schema ID matches `{schemaId}` |

Send `Authorization: Bearer <customer-specific-Service-App-access-token>` on each operation. Send `Content-Type: application/json` with `POST` and `PUT`. Use read scope for list/retrieve operations and write scope for create/update/delete operations, as specified by the live API reference.

### Rotate or change the registration

Use `PUT https://webexapis.com/v1/dataSources/{dataSourceId}`. Generate a new unpredictable nonce and send the complete intended body rather than a sparse patch. For example:

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

After the update, retrieve the same URL with `GET`. Verify the new nonce and expiry, the intended URL and claims, and `active` status. Test a new WebSocket connection against the rotated registration. This rotation does not refresh the Service App OAuth access token.

### Disable or restore the registration

To prevent new use without deleting the resource, send a complete `PUT` body with `status` set to `disabled`. Include a non-sensitive `errorMessage` if the customer administrator needs a reason. Do not include tokens, caller data, or internal infrastructure details.

Restore service with another complete `PUT` body that sets `status` to `active`, uses current nonce/lifetime values, and retains every intended registration field. Retrieve the resource afterward and verify the result.

### Delete the registration

Deletion is permanent. Before calling `DELETE https://webexapis.com/v1/dataSources/{dataSourceId}`, verify the organization ID, Service App application ID, data-source ID, and whether a published flow still depends on the resource. Record the offboarding decision. After deletion, use `GET` on the same resource URL and confirm that the resource is no longer returned.

## Secure the runtime WebSocket connection

Require `Authorization: Bearer <JWS>` on the HTTP upgrade for both WebSocket endpoints. Reject an authentication failure before accepting the WebSocket connection or processing application messages.

Validate the JWS in this order:

1. Require the Bearer scheme and a nonempty compact JWS.
2. Require the approved signing algorithm and issuer for the target Webex environment. The current public contract specifies `RS256`.
3. Obtain verification keys only from the documented, allowlisted issuer endpoint. Apply bounded timeouts and a defined cache/refresh failure policy.
4. Select the verification key by the protected header's `kid`. Reject a missing or unknown key ID.
5. Verify the signature, then validate time claims with a narrowly defined clock-skew allowance.
6. Compare `aud`, `sub`, and `jti` with the current registration's audience, subject, and nonce.
7. Compare `com.cisco.datasource.url` and `com.cisco.datasource.schema.uuid` with the registered URL and WebSocket schema ID.
8. Compare `com.cisco.org.uuid` with the customer organization permitted on this endpoint.
9. Bind the verified organization, data source, and conversation context to the accepted connection. Use that identity for catalog filtering and tenant isolation.

Never construct a verification-key URL from an unverified arbitrary issuer. Never log the compact token, signing keys, caller media, transcripts, or sensitive inputs. Log a bounded failure category such as `expired`, `issuer_mismatch`, `schema_mismatch`, or `org_mismatch` with a safe correlation value.

Expose production endpoints through `wss://`, typically on TCP 443, with a valid hostname and complete trust chain. Ensure network intermediaries preserve `Upgrade`, `Connection`, and `Authorization` headers and support expected message sizes, application heartbeat traffic, and long-lived connections. Plan for one concurrent `/v1/va` socket per active conversation and a controlled drain path for deployments.

Do not derive firewall rules from observed test traffic. The public contract does not publish stable Webex source IP ranges; obtain environment-specific network requirements through the approved Webex process.

## Implement the WebSocket contract

Send and receive JSON objects in WebSocket text frames. Carry audio as Base64 text inside the schema-defined JSON field; do not use binary WebSocket frames.

### Implement `/v1/va`

Accept one Webex-initiated connection for one conversation. Keep the same `conversation_id` for every turn on that connection, and reject an attempt to multiplex another conversation.

Every application envelope uses these base fields:

| Field | Rule |
| --- | --- |
| `type` | Use a schema-defined type: `VOICE_VA_REQUEST`, `VOICE_VA_RESPONSE`, `ERROR`, `PING`, or `PONG` |
| `seq` | Use a positive integer; each sender maintains its own monotonically increasing counter |
| `ts` | Use the message creation time in RFC 3339 date-time form |
| `conversation_id` | Use the stable conversation ID for this socket |
| `metadata` | Optional extension data; never substitute it for required fields |
| `payload` | Include the schema-defined body when required by the message type |

The Webex and partner sequence counters are independent. Do not use `seq` as a turn number or ordinary request-response correlation value. Sequence gaps are allowed; duplicates and regressions are invalid. The schema-level `PONG` described later has a specific echo rule.

Webex sends `SESSION_START` as the first `/v1/va` application request. A compact example is:

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

Require the payload `conversation_id` to match the envelope and accepted socket. Each `VoiceVARequest` payload also requires `customer_org_id` and exactly one `voice_va_input_type` wrapper. The wrapper contains `audio_input`, `dtmf_input`, or `event_input`. Optional fields include `virtual_agent_id`, `allow_partial_responses`, `vendor_specific_config`, and `additional_info`; validate them according to the AsyncAPI and do not use them for secrets or required protocol state.

Return a schema-valid `VOICE_VA_RESPONSE` with the connector's outgoing sequence, a timestamp, and the connection's conversation ID:

```json
{
  "type": "VOICE_VA_RESPONSE",
  "seq": 1,
  "ts": "2026-08-19T10:15:31Z",
  "conversation_id": "conversation-123",
  "payload": {
    "prompts": [
      {
        "audio_content_b64": "<base64-encoded-raw-mu-law-bytes>",
        "is_barge_in_enabled": true
      }
    ],
    "input_mode": "INPUT_VOICE_DTMF",
    "input_sensitive": false,
    "response_type": "CHUNK"
  }
}
```

A logical reply can contain zero or more `PARTIAL` messages, zero or more `CHUNK` messages, and exactly one `FINAL`. `FINAL` completes the reply; it does not close the socket. Keep the connection open for later turns until a terminal event or failure occurs.

Use the AsyncAPI for the complete response fields, enum values, and constraints. Important fields include `prompts`, `output_events`, `input_mode`, `input_handling_config`, `input_sensitive`, `session_transcript`, `session_summary`, `disable_prompt_cancellation`, and `response_type`. If you set speech timers, use the currently published fields `max_speech_timeout_msec`, `complete_timeout_msec`, and `incomplete_timeout_msec`.

### Implement `/v1/listVirtualAgents`

Use a separate handler for catalog discovery. Accept one bare request object, return one bare response object, then close the short-lived connection cleanly. Do not wrap these objects in `/v1/va` envelopes.

Request:

```json
{
  "customer_org_id": "org-456",
  "is_default_virtual_agent_enabled": false
}
```

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

`customer_org_id` is required. In the response, `virtual_agents` is required and each entry requires `id` and `name`; `description` is optional. Bind the requested organization to the verified JWS organization. Reject a mismatch and return only agents authorized for that customer. The selected agent ID can later appear as `virtual_agent_id` in `/v1/va` requests.

## Handle media, events, heartbeats, and closure

### Use the qualified media profile

Use this profile in both directions:

| Property | Value |
| --- | --- |
| Encoding | Raw G.711 mu-law, also called PCMU or u-law |
| Sample rate | 8000 Hz |
| Channels | One, mono |
| Sample size | 8 bit, one byte per sample |
| Container | None; do not add a WAV, RIFF, or other container header |
| JSON form | Base64 string |
| Caller field | `audio_input.caller_audio_b64` |
| Partner field | `prompts[].audio_content_b64` |
| Recommended decoded response chunk | 8000-16000 bytes, approximately 1-2 seconds |
| Minimum decoded response chunk | 320 bytes, approximately 40 milliseconds |
| Maximum decoded response chunk | 32 KB |

Calculate limits from decoded raw bytes, not the larger Base64 representation. Validate incoming encoding and sample rate before processing. Send response chunks as they become available; Webex buffers and paces them for playback. Do not add leading silence, pace transmission at playback speed, or wait for the complete response before sending the first chunk.

### Map events by direction

| Input or event | Direction | Required handling |
| --- | --- | --- |
| `SESSION_START` | Webex to connector | Initialize the conversation; send a welcome reply if required by the selected agent |
| `audio_input` | Webex to connector | Process caller media using the published format |
| `dtmf_input` | Webex to connector | Preserve the ordered DTMF events |
| `START_OF_DTMF` | Webex to connector | Treat as the start or interruption signal for DTMF collection |
| `NO_INPUT` | Either direction | Interpret from direction and current conversation state |
| `START_OF_INPUT` | Connector to Webex | Signal that caller speech has started |
| `END_OF_INPUT` | Connector to Webex | Signal that the caller utterance has ended |
| `NO_MATCH` | Connector to Webex | Report input that could not be understood or matched |
| `TRANSFER_TO_AGENT` | Connector to Webex | Request the handoff path configured in Flow Designer |
| `CUSTOM_EVENT` | Either direction | Apply only the provider/customer-agreed name, data, direction, and behavior |
| `SESSION_END` | Either direction | Finish the virtual-agent leg and clean up the conversation |

There is no `BARGE_IN` event in the public WebSocket schema. For an interruptible prompt, set `prompts[].is_barge_in_enabled` to `true` and send `START_OF_INPUT` when caller speech starts. Keep `disable_prompt_cancellation` separate: it controls whether a later partner reply cancels an earlier partial reply; it is not the caller barge-in setting.

When DTMF is accepted, set `input_mode` to `INPUT_EVENT_DTMF` or `INPUT_VOICE_DTMF` as appropriate and configure `input_handling_config.dtmf_config` from the published schema. Process the ordered `dtmf_events` values without applying the simulator's demo digit mappings.

Send `TRANSFER_TO_AGENT` to request a handoff; closing the socket alone is not a transfer instruction. Configure the associated outcome in the customer flow. For `SESSION_END`, finish applicable output, release per-conversation resources, and close in the order required by the state machine.

### Implement both heartbeat layers correctly

WebSocket has two distinct heartbeat mechanisms:

| Mechanism | Form | Responsibility |
| --- | --- | --- |
| RFC 6455 ping/pong | WebSocket protocol control frames | Your selected WebSocket implementation might handle these automatically, expose callbacks, or require configuration. Verify its documented behavior. |
| BYOVA `PING`/`PONG` | Schema-defined JSON objects sent in WebSocket text frames | Implement these messages in connector application code according to the BYOVA AsyncAPI. Protocol control-frame handling does not satisfy this requirement. |

When the connector receives a BYOVA JSON `PING`, promptly return a schema-valid JSON `PONG` with the same `seq` and `conversation_id` and an RFC 3339 timestamp. Keep this echo behavior separate from the connector's ordinary outbound response sequence.

Do not assume that any library, framework, runtime, or intermediary implements the BYOVA JSON heartbeat. Confirm the behavior of the stack you choose, test both heartbeat layers independently, and monitor the schema-level timeout path.

### Handle errors and terminal conditions

Use only the current public error codes: `unauthorized`, `bad_request`, `unsupported_media`, `upstream_error`, `rate_limit`, and `timeout`. Include the required base envelope values, code, numeric HTTP-style `status`, and a bounded `detail`. Never include a token, credential, raw audio, transcript, sensitive input, stack trace, or internal URL in the error.

Treat malformed known envelopes, sequence duplication/regression, conversation mismatch, heartbeat timeout, capacity failure, unexpected close, and network failure as terminal for that conversation. Send a bounded error when the state still allows it, close deterministically, and clear connection state. The current public behavior does not reconnect, resume, or replay an existing conversation after its socket fails.

## Configure Webex Contact Center

After the provider verifies the data source, ask the customer administrator to configure Contact Center.

### Create the Contact Center AI configuration

1. Sign in to Control Hub.
2. Navigate to **Contact Center** > **Integrations** > **Features**.
3. Create the Contact Center AI (CCAI) configuration used for the virtual agent.
4. Select the authorized Service App and its WebSocket data source.
5. Select the intended virtual agent when the catalog is presented.
6. Save the configuration.

![CCAI configuration page in Webex Control Hub](https://images.contentstack.io/v3/assets/bltd74e2c7e18c68b20/bltce69626ab2415ccf/2.png)

*Create the CCAI configuration that selects the authorized integration. See the [BYOVA provisioning guide](https://developer.webex.com/webex-contact-center/docs/bring-your-own-virtual-agent) for current labels and navigation.*

### Configure and publish the flow

1. Open Flow Designer.
2. Add a **Virtual Agent Voice** activity.
3. Select the CCAI configuration.
4. Connect the success, error, transfer, and custom-event paths needed by the flow. Give each `CUSTOM_EVENT` an explicit provider/customer-agreed meaning; the transport does not assign a generic business action.
5. Validate and publish the flow.

![Virtual Agent Voice activity configured in Webex Contact Center Flow Designer](https://images.contentstack.io/v3/assets/bltd74e2c7e18c68b20/blt4ebb66c23612b9c4/3.png)

*Configure the Virtual Agent Voice activity with the CCAI configuration. See the [BYOVA provisioning guide](https://developer.webex.com/webex-contact-center/docs/bring-your-own-virtual-agent) for the current flow procedure.*

### Map the entry point

1. Navigate to **Contact Center** > **Channels** > **Entry Point**.
2. Map the intended entry point to the published flow.
3. Save the mapping.
4. Place a controlled test call.

![Entry point mapped to a published flow in Webex Contact Center](https://images.contentstack.io/v3/assets/bltd74e2c7e18c68b20/bltef4256ccec99389b/4.png)

*Map the published BYOVA flow to the intended entry point. See the [BYOVA provisioning guide](https://developer.webex.com/webex-contact-center/docs/bring-your-own-virtual-agent) for the current mapping interface.*

During the test call, verify that Webex connects to the registered host, presents a bearer JWS, sends `SESSION_START`, and keeps subsequent turns on the same socket.

## Run the Java simulator

The Java 21 sample demonstrates the two WebSocket paths, JSON message handling, prerecorded response audio, and a fixture virtual-agent catalog. Use it as a learning and smoke-test aid, not as a production connector or conformance suite. See the [simulator README](simulators/byova-websocket-json-java/README.md) for configuration, authentication, endpoint-testing details, and the full sample-to-production gap list.

From the repository root:

```bash
cd bring-your-own/virtual-agent/web-socket-interface/simulators/byova-websocket-json-java
java -version
AUTH_ENABLED=false ./mvnw spring-boot:run
```

Keep the authentication-disabled server on loopback. In another terminal, connect a WebSocket test client to `ws://localhost:8086/v1/listVirtualAgents`, send the list request shown earlier, and verify that the response contains a `virtual_agents` array. Treat the returned entries as fixtures.

Then connect to `ws://localhost:8086/v1/va`, send the `SESSION_START` example, and observe the welcome response.

This smoke test proves only that the demonstration paths run locally. It does not prove current AsyncAPI conformance, complete JWS validation, BYOVA JSON PONG handling, raw-audio compliance on every code path, tenant isolation, concurrency safety, production TLS, or operational readiness.

## Validate before production

Complete this checklist against the current public AsyncAPI and record the result:

- **Schema:** Validate generated messages against both published AsyncAPI files. Test required fields, enums, independent sequence counters, stable conversation identity, response finality, bare catalog objects, error envelopes, and BYOVA JSON PING/PONG.
- **Authentication:** Test valid authorization and each rejection path independently: missing Bearer scheme, malformed or expired token, unapproved issuer or algorithm, unknown `kid`, invalid signature, and mismatched audience, subject, nonce, URL, schema, or organization.
- **Transport:** Verify DNS, `wss://`, certificate hostname and chain, expected port, forwarded upgrade and authorization headers, accepted message sizes, both heartbeat layers, idle timeout, orderly close, unexpected close, and deployment draining.
- **Media:** Verify raw G.711 mu-law at 8000 Hz, mono, 8 bit; Base64 fields; decoded chunk bounds; no WAV/RIFF header; prompt interruption; and timely first/subsequent chunks.
- **Conversation:** Test `SESSION_START`, multiple voice turns on one socket, optional `PARTIAL`/`CHUNK` followed by one `FINAL`, DTMF ordering, `NO_INPUT`, `NO_MATCH`, agreed custom events, transfer, both session-end directions, timeout, rate limit, malformed input, and dropped connections.
- **Control plane:** Confirm the customer sees the intended app developer, scopes, domain, and schema. Test create, list, retrieve, rotate, disable, restore, and controlled offboarding with the customer-specific Service App token.
- **Tenant isolation:** Test organization-to-JWS binding on both endpoints, including empty catalogs, unknown organizations, and cross-tenant attempts.
- **Operations:** Load-test one socket per active conversation, bounded work queues, dependency timeouts, horizontal scaling, key refresh, OAuth renewal, data-source rotation, and safe capacity rejection. Monitor categorized authentication failures, active sockets, first-audio and turn latency, heartbeat failures, close reasons, protocol errors, and dependency health without logging sensitive content.

## Troubleshoot

| Symptom | Check | Expected result |
| --- | --- | --- |
| HTTP 401 during WebSocket upgrade | Bearer syntax, expiry, approved issuer/algorithm, `kid`, signature, `aud`, `sub`, `jti`, URL, schema, and organization binding | A valid current Webex JWS upgrades; invalid material is rejected before acceptance |
| Data Sources API returns 401 or 403 | Customer authorization, Service App access-token expiry, required read/write scope, and accidental use of a Try It token | REST calls operate only on the authorized organization |
| TLS or upgrade fails | Public DNS, `wss://`, port, certificate hostname/chain, and preservation of Upgrade/Connection/Authorization headers | The HTTP request upgrades without weakening authentication |
| Connection opens but no welcome response | First text frame is a valid `VOICE_VA_REQUEST` containing `SESSION_START`, with matching conversation IDs and a valid sequence | The connector initializes the conversation and sends a schema-valid reply |
| Connection closes at heartbeat time | Verify a BYOVA JSON `PONG` echoes the JSON `PING`; test RFC 6455 control frames separately; inspect idle timeouts | Both heartbeat mechanisms work for the full conversation |
| Audio is distorted or delayed | Confirm raw mu-law/8000 Hz/mono/8-bit, Base64 integrity, decoded size, no container header, and immediate chunk transmission | Audio plays at the expected rate and begins promptly |
| Interruption or DTMF fails | Check `is_barge_in_enabled`, `START_OF_INPUT`, input mode, DTMF configuration, and ordered `dtmf_events` | Only configured prompts are interrupted and digits remain ordered |
| Reply never completes | Check for exactly one `FINAL`, a valid connector sequence, timeout handling, and no conversation mismatch | The reply completes once and the socket remains available for the next turn |
| Catalog is empty or contains another tenant's agents | Verify bare list objects, requested organization versus verified JWS organization, and replacement of fixture data | Only agents authorized for the customer are returned |
| Transfer does not occur | Check for `TRANSFER_TO_AGENT` and the published Flow Designer transfer path; do not rely on closing the socket | Webex follows the configured handoff path |
| Calls fail near credential expiry | Identify whether Service App OAuth or data-source runtime material expired, then run the corresponding renewal process | REST management and new WebSocket handshakes use current credentials |
| Sample frames fail schema validation | Add required envelope fields, current response fields, valid finality, heartbeat handling, and current media format | All emitted frames validate against the public AsyncAPI |

## References

- [BYOVA over WebSocket](https://developer.webex.com/mcp/docs/bring-your-own-virtual-agent-over-websocket)
- [Bring Your Own Virtual Agent](https://developer.webex.com/webex-contact-center/docs/bring-your-own-virtual-agent)
- [Bring Your Own Data Source](https://developer.webex.com/webex-contact-center/docs/bring-your-own-data-source-cc)
- [Data Sources API](https://developer.webex.com/admin/docs/api/v1/data-sources)
- [Service Apps](https://developer.webex.com/create/docs/service-apps)
- [BYOVA WebSocket AsyncAPI directory](https://github.com/webex/dataSourceSchemas/tree/main/Services/VoiceVirtualAgent_WebSocket/a38a10b7-43e4-4676-a076-a7d6dce9387d/AsyncApiSpec)
- [Conversation schema](https://github.com/webex/dataSourceSchemas/blob/main/Services/VoiceVirtualAgent_WebSocket/a38a10b7-43e4-4676-a076-a7d6dce9387d/AsyncApiSpec/VoiceVirtualAgent_WsSchema.json)
- [Virtual-agent catalog schema](https://github.com/webex/dataSourceSchemas/blob/main/Services/VoiceVirtualAgent_WebSocket/a38a10b7-43e4-4676-a076-a7d6dce9387d/AsyncApiSpec/VoiceVirtualAgent_WsListVASchema.json)
- [CiscoDevNet BYOVA WebSocket sample](https://github.com/CiscoDevNet/webex-contact-center-provider-sample-code/tree/main/bring-your-own/virtual-agent/web-socket-interface)

When the sample, this guide, and the public contract differ, follow the current Developer Portal and AsyncAPI, then update the connector and its tests together.
