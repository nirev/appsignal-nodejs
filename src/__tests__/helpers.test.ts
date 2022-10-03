import { NodeSDK } from "@opentelemetry/sdk-node"
import {
  ReadableSpan,
  SpanProcessor,
  TimedEvent
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { Client } from "../client"
import { trace } from "@opentelemetry/api"

import {
  setBody,
  setCategory,
  setCustomData,
  setHeader,
  setName,
  setParams,
  setSessionData,
  setTag,
  setNamespace,
  setError,
  sendError
} from "../helpers"

function throwError() {
  throw new Error("Whoopsie!")
}

describe("Helpers", () => {
  let spans: ReadableSpan[] = []
  let sdk: NodeSDK
  let tracerProvider: NodeTracerProvider

  const spanProcessor: SpanProcessor = {
    onEnd(span) {
      spans.push(span)
    },

    shutdown() {
      return Promise.resolve()
    },
    forceFlush() {
      return Promise.resolve()
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onStart(_span, _context) {}
  }

  beforeAll(() => {
    sdk = new NodeSDK({
      instrumentations: []
    })

    sdk.start()

    tracerProvider = new NodeTracerProvider()
    tracerProvider.addSpanProcessor(spanProcessor)
    tracerProvider.register()
  })

  beforeEach(() => {
    spans = []
  })

  afterAll(() => {
    sdk.shutdown()
  })

  it("set the attributes", () => {
    tracerProvider.getTracer("test").startActiveSpan("Some span", span => {
      setBody("SELECT * FROM users")
      setCategory("some.query")
      setName("Some query")
      setCustomData({ chunky: "bacon" })
      setParams({ id: 123 })
      setSessionData({ admin: true })
      setHeader("content-type", "application/json")
      setTag("something", true)
      setNamespace("web")

      span.end()
    })

    expect(spans.length).toEqual(1)
    expect(spans[0].attributes).toMatchObject({
      "appsignal.body": "SELECT * FROM users",
      "appsignal.category": "some.query",
      "appsignal.name": "Some query",
      "appsignal.custom_data": '{"chunky":"bacon"}',
      "appsignal.request.parameters": '{"id":123}',
      "appsignal.request.session_data": '{"admin":true}',
      "appsignal.request.headers.content-type": "application/json",
      "appsignal.tag.something": true,
      "appsignal.namespace": "web"
    })
  })

  it("handles cyclic references", () => {
    tracerProvider.getTracer("test").startActiveSpan("Some span", span => {
      const root: Record<string, any> = {}
      root.nested = root
      setCustomData(root)

      span.end()
    })

    expect(spans.length).toEqual(1)
    expect(spans[0].attributes).toMatchObject({
      "appsignal.custom_data": '{"nested":"[cyclic value: root object]"}'
    })
  })

  describe("setError", () => {
    function expectErrorEvent(event: TimedEvent) {
      expect(event).toMatchObject({
        name: "exception",
        attributes: {
          "exception.message": "Whoopsie!",
          "exception.type": "Error",
          "exception.stacktrace": expect.stringContaining("at throwError (")
        }
      })
    }

    it("sets an error", () => {
      tracerProvider.getTracer("test").startActiveSpan("Some span", span => {
        try {
          throwError()
        } catch (err) {
          setError(err)
        }

        span.end()
      })

      expect(spans.length).toEqual(1)
      expect(spans[0].events.length).toEqual(1)
      expectErrorEvent(spans[0].events[0])
    })

    it("sends an error as a separate span", () => {
      tracerProvider.getTracer("test").startActiveSpan("Some span", span => {
        try {
          throwError()
        } catch (err) {
          sendError(err)
        }

        expect(trace.getActiveSpan()).toBe(span)

        span.end()
      })

      expect(spans.length).toEqual(2)

      const activeSpan = spans.find(span => span.name == "Some span")
      if (!activeSpan) throw new Error("No active span")

      expect(activeSpan.events.length).toEqual(0)

      const errorSpan = spans.find(span => span.name == "Error")
      if (!errorSpan) throw new Error("No error span")

      expect(errorSpan.events.length).toEqual(1)
      expectErrorEvent(spans[0].events[0])
    })

    it("sends an error span with additional data", () => {
      try {
        throwError()
      } catch (err) {
        sendError(err, () => {
          setCustomData({ chunky: "bacon" })
        })
      }

      expect(spans.length).toEqual(1)
      expect(spans[0].events.length).toEqual(1)
      expectErrorEvent(spans[0].events[0])

      expect(spans[0].attributes).toMatchObject({
        "appsignal.custom_data": '{"chunky":"bacon"}'
      })
    })
  })
})
