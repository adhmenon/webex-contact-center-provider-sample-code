# BYoVA WebSocket Sample — JSON Schema (Spring Boot / Java)

A reference implementation of the Webex Contact Center **Bring-Your-Own-Virtual-Agent (BYoVA) WebSocket** interface using the **JSON wire format**, built with Spring Boot 4 and the standard `spring-boot-starter-websocket`. It exposes two endpoints:

- `/v1/va` — bidirectional channel that carries text JSON envelopes for everything: control messages, virtual-agent responses, and caller audio (base64-encoded inside `VoiceInput.caller_audio_b64`). No binary frames are used.
- `/v1/listVirtualAgents` — request/response endpoint used by the WxCC platform to discover the virtual agents this server can serve.

The sample handles the same three input types the WxCC platform sends:

- **Event input** (`SESSION_START`, `NO_INPUT`, `CUSTOM_EVENT`, …)
- **Audio input** — mu-law 8 kHz caller audio, silence-detected, buffered, and echoed back in chunked mode.
- **DTMF input** — digits mapped to pre-recorded audio prompts; `5` triggers `TRANSFER_TO_AGENT`, and `*` triggers `SESSION_END`.

The sample is deliberately self-contained — prompts are loaded from the classpath under `src/main/resources/audio/` — so it can be run as a local smoke test without an external AI service. It is not a production-ready connector or a complete conformance implementation. Review [Production gaps to address](#production-gaps-to-address) before adapting it.

For the underlying call-flow contract, see the [BYoVA over WebSocket development guide](../../README.md).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Project Layout](#project-layout)
- [Building a JAR](#building-a-jar)
- [Configuration](#configuration)
- [Authentication (JWS / JWT validation)](#authentication-jws--jwt-validation)
- [Extending the Sample](#extending-the-sample)
- [Production gaps to address](#production-gaps-to-address)

## Prerequisites

- **JDK 21 or later** (the project pins `java.version=21`).
- **Network access to Maven Central** the first time you build, to download Spring Boot, Jackson, Nimbus JOSE+JWT, and Lombok.

## Quick Start

Run the server from source on port `8086` with authentication disabled for this loopback-only test:

```bash
AUTH_ENABLED=false ./mvnw spring-boot:run
```

Once you see `Tomcat started on port 8086`, open a WebSocket connection (e.g. with `wscat`):

```bash
# Voice/event channel
wscat -c ws://localhost:8086/v1/va -H "Authorization: Bearer <jwt>"

# Virtual-agent catalog
wscat -c ws://localhost:8086/v1/listVirtualAgents -H "Authorization: Bearer <jwt>"
```

> **Warning:** Disable authentication only for loopback testing. Configure JWS validation before you expose the server through a tunnel or public ingress.

## Project Layout

```
byova-websocket-json-java/
├── pom.xml
└── src/main/
    ├── java/com/cisco/wccai/
    │   ├── ByovaWebsocketJsonJavaApplication.java # Spring Boot entry point
    │   ├── auth/
    │   │   ├── AccessTokenException.java                # Typed validation failure
    │   │   ├── AuthProperties.java                      # `auth.*` (JWT settings)
    │   │   ├── AuthorizationHandler.java                # Strategy interface
    │   │   ├── AuthorizationHandlerFactory.java         # Picks a handler from token shape
    │   │   ├── AuthorizationHandshakeInterceptor.java   # JWT check on WS upgrade
    │   │   ├── JWTAuthorizationHandler.java             # Nimbus-based JWS verifier + JWKS cache
    │   │   └── PublicKeyResponse.java                   # JWKS response POJO
    │   ├── common/
    │   │   ├── AudioConstant.java                       # Classpath resource names
    │   │   └── AudioProcessingException.java
    │   ├── config/
    │   │   ├── JacksonConfig.java                       # ObjectMapper configuration
    │   │   └── WebSocketConfig.java                     # Endpoint + handshake registration
    │   ├── handler/
    │   │   ├── ListVirtualAgentWebSocketHandler.java    # /v1/listVirtualAgents
    │   │   └── VirtualAgentWebSocketHandler.java        # /v1/va
    │   ├── service/                                     # Audio, DTMF, processor, adaptor
    │   ├── util/                                        # Audio file/format utilities
    │   └── ws/                                          # JSON DTOs (envelopes, voice, list)
    └── resources/
        ├── application.properties                       # Default config
        └── audio/                                       # Pre-recorded prompt WAVs
```

## Building a JAR

```bash
./mvnw clean package -DskipTests
java -jar target/byova-websocket-json-java-1.0.0.jar
```

The packaged jar is a Spring Boot fat jar with `ByovaWebsocketJsonJavaApplication` as the entry point.

## Configuration

All knobs are exposed through Spring Boot configuration; see [`src/main/resources/application.properties`](./src/main/resources/application.properties) for the defaults. The most commonly tweaked values:

| Property                                      | Default | Description                                                  |
|-----------------------------------------------|---------|--------------------------------------------------------------|
| `server.port`                                 | `8086`  | HTTP/WebSocket listening port                                |
| `spring.websocket.max-binary-message-buffer-size` | `10485760` | Max binary frame size (10 MB)                            |
| `spring.websocket.max-session-idle-timeout`   | `900000` | Session idle timeout (15 min)                                |
| `voice.va.input.timeout-millis`               | `10000` | Complete/incomplete speech timeout reported to WxCC          |
| `voice.va.audio.use-chunked-audio`            | `true`  | Emit raw-audio `CHUNK` responses. Keep this `true` for the current WebSocket media profile. The legacy `false` path adds a WAV header and is not compatible with the current profile. |
| `voice.va.audio.amplitude-threshold`          | `2000`  | PCM absolute amplitude above which a sample is "speech"      |
| `voice.va.audio.write-to-file`                | `false` | Persist captured caller audio to `~/recorded-audio/`         |
| `voice.va.dtmf.input-length`                  | `9`     | Max digits reported to WxCC                                  |
| `voice.va.dtmf.term-char`                     | `DTMF_DIGIT_POUND` | Terminator key                                    |
| `auth.enabled`                                | `true`  | Master switch for JWT validation; see [Authentication](#authentication-jws--jwt-validation) |
| `auth.datasource-url`                         | _placeholder_ | Public URL of this BYoVA service registered in Webex CC (must match `com.cisco.datasource.url` claim) |
| `auth.datasource-schema-uuid`                 | _placeholder_ | BYoVA schema UUID provisioned for your tenant        |
| `auth.public-key-cache-minutes`               | `60`    | TTL of the cached Identity Broker JWKS                       |

Override at runtime via Spring's standard config sources (env vars, `--prop=value` CLI args, external `application.properties`, …):

```bash
SERVER_PORT=9090 \
VOICE_VA_AUDIO_WRITE_TO_FILE=true \
mvn spring-boot:run
```

## Authentication (JWS / JWT validation)

Every WebSocket upgrade request is authenticated by [`AuthorizationHandshakeInterceptor`](./src/main/java/com/cisco/wccai/auth/AuthorizationHandshakeInterceptor.java) **before** a session is opened. The interceptor reads the `Authorization` HTTP header presented during the handshake, parses it as a Cisco JWS/JWT, and runs four checks:

1. **Signature verification** against the issuer's public JWKS, fetched from `<issuer>/oauth2/v2/keys/verificationjwk` and cached in-memory (default TTL 60 min, with stale-cache fallback on HTTP 429).
2. **Expiration** — the `exp` claim must be in the future.
3. **Required claims + issuer allow-list** — `iss` must be one of `auth.valid-issuers`, and `aud`, `sub`, and `jti` must all be present.
4. **Datasource binding** — the `com.cisco.datasource.url` and `com.cisco.datasource.schema.uuid` claims must equal the `auth.datasource-url` and `auth.datasource-schema-uuid` values configured for this server. This is what guarantees the token was minted **for this BYoVA service and this schema** and not for some other Webex tenant or service.

A failed check aborts the handshake with HTTP `401 Unauthorized` — no WebSocket session is opened and no further bytes are processed.

### Required configuration

In any deployed environment you must set:

```properties
auth.enabled=true
auth.datasource-url=wss://<your-public-byova-host>
auth.datasource-schema-uuid=a38a10b7-43e4-4676-a076-a7d6dce9387d
```

`datasource-url` and `datasource-schema-uuid` must match the values produced when you register the data source (see the [BYoVA over WebSocket development guide](../../README.md) for the onboarding flow). The shipped `application.properties` contains obvious placeholder values that **must** be replaced — leaving them in place will reject every legitimate token.

### Disabling for local development

Setting `auth.enabled=false` skips validation entirely. Use this **only** for local smoke tests with `wscat` or a test client; never disable it in any environment that reaches the public Internet or the Webex CC platform.

```bash
AUTH_ENABLED=false ./mvnw spring-boot:run
```

### Where to extend it

- To support OAuth2 opaque tokens or a custom scheme, add a new `AuthorizationHandler` implementation and wire it into [`AuthorizationHandlerFactory`](./src/main/java/com/cisco/wccai/auth/AuthorizationHandlerFactory.java).
- To attach the validated subject/org id to the session for downstream use, store it under `attributes` in `AuthorizationHandshakeInterceptor#beforeHandshake` (already done for `trackingId`); the WebSocket handlers can then read it from `WebSocketSession#getAttributes()`.

## Extending the Sample

- **Connect a real speech service** — replace the audio echo logic in `service/AudioStreamingService` with calls to your ASR/NLU engine, and stream raw G.711 mu-law audio in `CHUNK` envelopes followed by one `FINAL` response.
- **Add TLS termination** — Spring Boot exposes the standard `server.ssl.*` properties; configure a keystore to terminate TLS in-process or, more commonly, terminate at your ingress and forward over plain HTTP on a private network.
- **Change the virtual-agent catalog** — override `service/VirtualAgentProcessor#sendVirtualAgentsList` to return your own list (e.g. fetched from a database).

## Production gaps to address

Treat the sample as a code-navigation aid. Before connecting a Webex Contact Center tenant, address these gaps:

| Area | Current sample behavior | Required production work |
| --- | --- | --- |
| Response envelope | Response builders do not populate the required `seq`, `ts`, and `conversation_id` fields. | Maintain a per-connection outbound sequence counter, add an RFC 3339 timestamp, and return the connection's conversation ID on every response and error. |
| Application heartbeat | The handler logs an application `PING` but does not send the required application `PONG`. Its `handlePongMessage` method handles protocol-level WebSocket pong frames only. | Send a schema-valid `PONG` that echoes the application `PING` sequence number. Test timeout behavior. |
| Audio | Chunked mode sends raw audio, but the legacy non-chunked path prepends a WAV header. | Keep raw-audio chunking enabled or replace the legacy path. Never send WAV or RIFF headers for the current media profile. |
| Authentication | The sample verifies a signature, expiry, issuer presence, required claims, and data-source binding. It does not implement every production hardening control. | Validate the issuer before network access, pin the accepted algorithm, select the expected `kid`, validate the exact audience and subject, enforce network timeouts, and define JWKS rotation and failure policy. |
| Concurrency | Some demonstration state is held in singleton service fields. | Keep conversation, DTMF, audio, and sequence state isolated per WebSocket connection. |
| Operations | TLS termination, load-balancer behavior, draining, capacity limits, and alerts are deployment-specific. | Test one long-lived connection per active conversation, graceful draining, message limits, backpressure, and failure handling at production scale. |
| Tests | The module does not currently contain automated conformance tests. | Add schema validation and end-to-end tests for the lifecycle, media, events, heartbeats, errors, and connection closure. |
