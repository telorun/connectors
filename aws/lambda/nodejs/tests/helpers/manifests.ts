import { MODULE_SOURCES } from "./prepare-fixture.js";

/** Minimal Telo.Application fixtures, one per handler kind. Each imports the
 *  Lambda / Run / Type modules by relative path from the LIVE workspace copy
 *  `prepare-fixture` lays down in the fixture (no published-version pins to
 *  maintain) plus a small `Run.Value` handler so the E2E test exercises
 *  Function → handler-kind → user invocable → outcome rendering end to end. */

export const directManifest = `\
kind: Telo.Application
metadata:
  name: E2eDirect
  version: 1.0.0
imports:
  Lambda: ${MODULE_SOURCES.lambda}
  Run: ${MODULE_SOURCES.run}
  Type: ${MODULE_SOURCES.type}
targets: [!ref Main]
---
kind: Run.Value
metadata: { name: Echo }
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    additionalProperties: true
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    additionalProperties: true
value:
  received: !cel "inputs"
---
kind: Lambda.Direct
metadata: { name: Greeter }
handler: !ref Echo
inputs:
  payload: !cel "event"
---
kind: Lambda.Function
metadata: { name: Main }
handlers:
  - !ref Greeter
`;

export const httpApiManifest = `\
kind: Telo.Application
metadata:
  name: E2eHttpApi
  version: 1.0.0
imports:
  Lambda: ${MODULE_SOURCES.lambda}
  Run: ${MODULE_SOURCES.run}
  Type: ${MODULE_SOURCES.type}
targets: [!ref Main]
---
kind: Run.Value
metadata: { name: GreetById }
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [id]
    properties:
      id: { type: string }
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [message]
    properties:
      message: { type: string }
value:
  message: !cel "'Hello ' + inputs.id + '!'"
---
kind: Lambda.HttpApi
metadata: { name: Web }
routes:
  - request:
      method: GET
      path: "/users/{id}"
    handler: !ref GreetById
    inputs:
      id: !cel "request.params.id"
    returns:
      - status: 200
        content:
          application/json:
            body: !cel "result"
---
kind: Lambda.Function
metadata: { name: Main }
handlers:
  - !ref Web
`;

export const sqsManifest = `\
kind: Telo.Application
metadata:
  name: E2eSqs
  version: 1.0.0
imports:
  Lambda: ${MODULE_SOURCES.lambda}
  Run: ${MODULE_SOURCES.run}
  Type: ${MODULE_SOURCES.type}
targets: [!ref Main]
---
kind: Run.Value
metadata: { name: ProcessRecords }
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [records]
    properties:
      records:
        type: array
        items:
          type: object
          additionalProperties: true
          properties:
            messageId: { type: string }
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    additionalProperties: true
value:
  batchItemFailures: !cel "inputs.records.filter(r, r.messageId == 'bad').map(r, {'itemIdentifier': r.messageId})"
---
kind: Lambda.Sqs
metadata: { name: Orders }
queue:
  queueName: orders
handler: !ref ProcessRecords
inputs:
  records: !cel "event.Records"
---
kind: Lambda.Function
metadata: { name: Main }
handlers:
  - !ref Orders
`;
