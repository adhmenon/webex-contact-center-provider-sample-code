# Bring Your Own Virtual Agent (BYoVA)

The **Bring-Your-Own-Virtual-Agent (BYoVA)** initiative empowers developers and AI vendors to seamlessly integrate their own conversational interfaces (bots, IVR replacements, agent assistants, …) with the Webex Contact Center (WxCC) IVR. This directory contains everything you need to onboard a new BYoVA tenant and stand up a reference Virtual Agent server in the language and transport of your choice.

This README focuses on the parts of the journey that are **specific to virtual agents** — what a voice virtual agent does, the supported integration variants, how to onboard your service into Webex, and how runtime authentication works. Use the interface-specific guides for the actual wire contract: [BYoVA over gRPC](./grpc-interface/README.md) or the complete [BYoVA over WebSocket development guide](./web-socket-interface/README.md).

## Table of Contents

- [What Is a Voice Virtual Agent?](#what-is-a-voice-virtual-agent)
- [Integration Variants in This Directory](#integration-variants-in-this-directory)
- [Audio & Runtime Constraints](#audio--runtime-constraints)
- [Onboarding a New Customer / Partner](#onboarding-a-new-customer--partner)
    - [Step 1. Create and Authorize a Service App](#step-1-create-and-authorize-a-service-app)
    - [Step 2. Generate Service-App Tokens](#step-2-generate-service-app-tokens)
    - [Step 3. Register a Data Source](#step-3-register-a-data-source)
    - [Step 4. Create a BYoVA Config (Feature) and Flow](#step-4-create-a-byova-config-feature-and-flow)
- [Runtime Authentication: JWS Validation](#runtime-authentication-jws-validation)
- [Operational Considerations](#operational-considerations)
- [Where to Go Next](#where-to-go-next)
- [References](#references)

---

## What Is a Voice Virtual Agent?

A voice virtual agent is the conversational endpoint that handles a Contact Center call when the flow routes the caller to it. A BYoVA connector adapts either a speech-to-text, agent, and text-to-speech pipeline or a speech-to-speech model to the selected Webex contract. It must:

- Process caller audio, DTMF, and session events.
- Detect input boundaries and map caller turns to the partner AI runtime.
- Return qualified audio prompts and response-finality signals.
- Support interruption, no-input/no-match behavior, transfer, and session termination as required by the experience.
- Optionally return transcript content when transcript publication is enabled for the customer organization.

![Sample voice virtual agent call escalated to a human agent](./resources/images/VACallFlowWithEscalation.jpg)

*Fig 1: A sample virtual agent call that is escalated to a human agent.*

## Integration Variants in This Directory

WxCC supports two transport protocols for BYoVA — gRPC (Protobuf) and WebSocket (JSON). The table below maps each combination to the reference implementation in this directory. Both variants implement the same conceptual contract (session start, audio in/out, DTMF, events, transfer, end); they just differ in transport and serialization.

| Transport | Schema | Data-source schema ID | Interface directory |
|---|---|---|---|
| **gRPC** (each interaction carried on its own short-lived RPC) | Protobuf | `5397013b-7920-4ffc-807c-e8a3e0a18f43` | [`grpc-interface/`](./grpc-interface/) |
| **WebSocket** (one persistent connection for a conversation) | JSON | `a38a10b7-43e4-4676-a076-a7d6dce9387d` | [`web-socket-interface/`](./web-socket-interface/) |

Each interface directory contains its own `README.md` (call-flow walkthrough, sequence diagrams, framing rules) alongside a `simulators/` folder with the runnable reference servers — open the directory link to browse both side by side.

## Audio & Runtime Constraints

Audio requirements depend on the transport and selected schema. BYoVA over WebSocket currently uses raw G.711 mu-law at 8 kHz, mono, with no WAV or RIFF header. Follow the [WebSocket media profile](./web-socket-interface/README.md#audio-format-and-chunking) when you use the WebSocket schema. Follow the [gRPC guide](./grpc-interface/README.md) for gRPC media requirements.

---

## Onboarding a New Customer / Partner

The Webex side of the integration is set up through Webex for Developers and Control Hub. Complete these four steps for each customer organization.

### Step 1. Create and Authorize a Service App

A **Service App** is the integration framework BYoVA uses to register your communication endpoint with Webex. It lets you request admin permission to call the [Bring Your Own Data Source (BYoDS)](https://developer.webex.com/admin/docs/api/v1/data-sources/register-a-data-source) APIs on behalf of an org, without depending on any single user's auth grant.

1. Sign in to [Webex for Developers](https://developer.webex.com/create/docs/service-apps) and create a Service App.
2. Add `spark-admin:datasource_read` and `spark-admin:datasource_write`.
3. Add the data exchange domain without a scheme, path, wildcard, or port.
4. Select the data-source schema ID for the transport in [Integration variants](#integration-variants-in-this-directory).
5. Save the client ID and the one-time-displayed client secret in a secret manager.
6. Submit the app for organization-admin approval.

   ![Service-app authorization request](./resources/images/serviceAppAuthorization.png)

7. The Full Admin reviews the submitted scopes, schema, and domains under **Management** > **Apps** > **Service Apps** in [Control Hub](https://admin.webex.com/apps/serviceapps), then selects **Authorize** and **Save**.

   ![Org-admin view of a pending service-app approval](./resources/images/serviceAppAdminView.png)

> **Tip:** See [Using Webex Service Apps](https://developer.webex.com/create/docs/service-apps) for the complete developer and administrator flows.

### Step 2. Generate Service-App Tokens

Once the service app is authorized, go to the **My Apps** section of the developer portal, open the app, pick the authorized org from the dropdown, and generate a token pair.

![Generating an access/refresh token pair for the service app](./resources/images/tokenGeneration.png)

The pair contains:

- An **access token** — typically valid for **14 days**, used as the bearer token on every BYoDS API call.
- A **refresh token** — typically valid for **90 days**, used to mint new access tokens before expiry. See [Using the Refresh Token](https://developer.webex.com/create/docs/integrations#using-the-refresh-token) for the renewal flow.

> **Important:** Store both tokens in a secret manager (Vault / KMS / Secret Manager / equivalent). They authorize all subsequent data-source operations — treat them like passwords.

### Step 3. Register a Data Source

A **Data Source** is the external URL Webex will use to reach your VA server (over gRPC or WebSocket, depending on the variant). Its host must belong to the Data Exchange Domain you provided when the Service App was created.

Register the data source through the [Data Sources REST API](https://developer.webex.com/admin/docs/api/v1/data-sources):

```bash
curl --request POST \
     --url https://webexapis.com/v1/dataSources \
     --header 'Accept: application/json' \
     --header 'Authorization: Bearer <SERVICE_APP_ACCESS_TOKEN>' \
     --header 'Content-Type: application/json' \
     --data '{
       "schemaId": "<TRANSPORT_SCHEMA_ID>",
       "url": "<REGISTERED_CONNECTOR_URL>",
       "audience": "audience",
       "subject": "VA",
       "nonce": "65793b88-ad6e-4ec8-929e-b408038251e3",
       "tokenLifetimeMinutes": 1440
     }'
```

A successful response looks like:

```json
{
    "id": "f0a84d12-2760-4610-8c84-719a622f4748",
    "schemaId": "<TRANSPORT_SCHEMA_ID>",
    "orgId": "63b02f90-9cc6-43b8-aa6d-cad425ac554c",
    "applicationId": "Cf2e954e018f2de8c1403e2618323551df65",
    "status": "active",
    "jwsToken": "<SIGNED_JWS>",
    "createdBy": "3e4d3b27-1bf1-4916-8d0c-d27fd765fa52",
    "createdAt": "2024-05-20T15:50:06.754103"
}
```

A few key fields:

- **`schemaId`** — select the ID for your transport from the table in [Integration variants](#integration-variants-in-this-directory). The schema selects the wire contract.
- **`url`** — use the public endpoint form required by the selected transport. For WebSocket, use a secure `wss://` URL on an authorized data exchange domain.
- **`tokenLifetimeMinutes`** — set the runtime JWS lifetime from 1 through 1440 minutes. Choose an operationally practical value and rotate it before expiry.
- **`jwsToken`** — use the response value for inspection or controlled testing only. At runtime, validate the current bearer token Webex presents rather than comparing it with this literal value.

> **Important:** Keep the data source token current for each customer organization. Use the [Update a Data Source](https://developer.webex.com/admin/docs/api/v1/data-sources/update-a-data-source) `PUT` API with a new nonce before expiry. Webex will not open new runtime connections with an expired data-source token.

### Step 4. Create a BYoVA Config (Feature) and Flow

Finally, link the authorized service app into a Contact Center configuration so flow designers can pick it.

1. In Control Hub, go to [Integrations → Features](https://admin.webex.com/wxcc/integrations/features) and create a new BYoVA feature, selecting the authorized service app from the dropdown.

   ![Creating a new BYoVA feature in Control Hub](./resources/images/configCreation.png)

2. In the [Flow Designer](https://admin.webex.com/wxcc/customer-experience/routing-flows/flows), open (or create) the routing flow that should hand the call off to your VA. Add a **Virtual Agent Voice** activity, select the feature you just created, and configure its success, error, transfer, and custom-event paths.
3. Map the entry point that fronts your IVR to this flow:
   `Entry Point → Routing Strategy → Flow`.

Once the entry point is mapped and the flow is published, calls landing on that entry point will be routed to your VA server using the data source registered in Step 3.

---

## Runtime Authentication: JWS Validation

For every call WxCC opens to your server, it presents the current data-source JWS in gRPC metadata or as a WebSocket `Authorization: Bearer` header. Your server **must** validate the JWS before processing the request.

The validation flow is:

1. Parse the incoming JWS (it's a standard signed JWT — header, payload, signature).
2. Read the `kid` (key ID) from the JOSE header.
3. Fetch Cisco's public keys from the JWKS endpoint and select the key whose ID matches `kid`.
4. Verify the signature against that key (RSA / RSASSA).
5. Verify the standard claims (`iss`, `aud`, `exp`, `nbf`, …) against your expected values.


For a complete reference implementation including JWKS retrieval, key caching, claim validation, and the gRPC `ServerInterceptor` that ties it all together, see the [virtual agent simulators](./grpc-interface/simulators/byova-grpc-java/src/main/java/com/cisco/wccai/byova/grpc/AuthorizationServerInterceptor.java). The Python sample interceptor (`AuthInterceptor.py`) under each Python module shows the equivalent flow on that side.

> **Production checklist:**
> - Pin the JWS algorithm (e.g. RS256). Reject `none` and any algorithm you don't expect.
> - Cache the JWKS, but honour the `Cache-Control` headers — keys can rotate.
> - Always verify `exp` and (when present) `nbf` against the current UTC time with a small clock-skew tolerance (≤30 s).
> - Validate `iss` and `aud` against the values you used when registering the data source.

## Operational Considerations

A few things worth thinking about before you go live:

- **Health and readiness.** Expose deployment health and readiness checks for your own load balancers and operations tooling. Keep them separate from the BYoVA application `PING` and `PONG` heartbeat messages.
- **mTLS.** Optional BYoVA mutual TLS applies to the gRPC variant. WebSocket uses server-authenticated TLS plus bearer-token validation.
- **Secrets handling.** Service-app tokens and any API keys for the upstream AI service must live in a managed secret store — never in source control or container images.
- **Observability.** Capture the `conversation_id` on every session log so you can trace the call across Webex Contact Center and your virtual-agent stack without logging caller audio or credentials.

## Where to Go Next

- For WebSocket, follow the [end-to-end WebSocket guide](./web-socket-interface/README.md) and its published [AsyncAPI specifications](https://github.com/webex/dataSourceSchemas/tree/main/Services/VoiceVirtualAgent_WebSocket/a38a10b7-43e4-4676-a076-a7d6dce9387d/AsyncApiSpec).
- For gRPC, follow the [gRPC guide](./grpc-interface/README.md) and its published [Protobuf definitions](https://github.com/webex/dataSourceSchemas/tree/main/Services/VoiceVirtualAgent/5397013b-7920-4ffc-807c-e8a3e0a18f43/Proto).

## References

1. **BYoVA developer docs** — https://developer.webex.com/webex-contact-center/docs/bring-your-own-virtual-agent
2. **Service Apps** — https://developer.webex.com/create/docs/service-apps
3. **BYoDS Data Sources API** — https://developer.webex.com/admin/docs/api/v1/data-sources
4. **Schema definitions** — https://github.com/webex/dataSourceSchemas/tree/main/Services
5. **Refresh-token flow** — https://developer.webex.com/create/docs/integrations#using-the-refresh-token
