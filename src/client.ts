import { AppsignalOptions } from "./config/options"
import { Extension } from "./extension"
import { Configuration } from "./config"
import { Metrics } from "./metrics"
import * as gcProbe from "./probes/v8"
import { Logger } from "./logger"
import { NoopMetrics } from "./noops"
import { demo } from "./demo"
import { VERSION } from "./version"
import { setParams, setSessionData } from "./helpers"

import { Instrumentation } from "@opentelemetry/instrumentation"
import {
  ExpressInstrumentation,
  ExpressLayerType
} from "@opentelemetry/instrumentation-express"
import { GraphQLInstrumentation } from "@opentelemetry/instrumentation-graphql"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis"
import { KoaInstrumentation } from "@opentelemetry/instrumentation-koa"
import { MySQL2Instrumentation } from "@opentelemetry/instrumentation-mysql2"
import { MySQLInstrumentation } from "@opentelemetry/instrumentation-mysql"
import { NodeSDK, NodeSDKConfiguration } from "@opentelemetry/sdk-node"
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg"
import { PrismaInstrumentation } from "@prisma/instrumentation"
import { RedisDbStatementSerializer } from "./instrumentation/redis/serializer"
import { RedisInstrumentation as Redis4Instrumentation } from "@opentelemetry/instrumentation-redis-4"
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis"
import { SpanProcessor, TestModeSpanProcessor } from "./span_processor"

const DefaultInstrumentations = {
  "@opentelemetry/instrumentation-express": ExpressInstrumentation,
  "@opentelemetry/instrumentation-graphql": GraphQLInstrumentation,
  "@opentelemetry/instrumentation-http": HttpInstrumentation,
  "@opentelemetry/instrumentation-ioredis": IORedisInstrumentation,
  "@opentelemetry/instrumentation-koa": KoaInstrumentation,
  "@opentelemetry/instrumentation-mysql2": MySQL2Instrumentation,
  "@opentelemetry/instrumentation-mysql": MySQLInstrumentation,
  "@opentelemetry/instrumentation-pg": PgInstrumentation,
  "@opentelemetry/instrumentation-redis": RedisInstrumentation,
  "@opentelemetry/instrumentation-redis-4": Redis4Instrumentation,
  "@prisma/instrumentation": PrismaInstrumentation
}

export type DefaultInstrumentationName = keyof typeof DefaultInstrumentations

type ConfigArg<T> = T extends new (...args: infer U) => unknown ? U[0] : never
type DefaultInstrumentationsConfigMap = {
  [Name in DefaultInstrumentationName]?: ConfigArg<
    typeof DefaultInstrumentations[Name]
  >
}

type AdditionalInstrumentationsOption = NodeSDKConfiguration["instrumentations"]

export type Options = AppsignalOptions & {
  additionalInstrumentations: AdditionalInstrumentationsOption
}

/**
 * AppSignal for Node.js's main class.
 *
 * Provides methods to control the AppSignal instrumentation and the system
 * agent.
 *
 * @class
 */
export class Client {
  readonly VERSION = VERSION

  config: Configuration
  readonly logger: Logger
  extension: Extension

  #metrics: Metrics
  #sdk?: NodeSDK

  /**
   * Global accessors for the AppSignal client
   */
  static get client(): Client {
    return global.__APPSIGNAL__
  }

  /**
   * Global accessors for the AppSignal Config
   */
  static get config(): Configuration {
    return this.client.config
  }

  /**
   * Global accessors for the AppSignal Logger
   */
  static get logger(): Logger {
    return this.client.logger
  }

  /**
   * Creates a new instance of the `Appsignal` object
   */
  constructor(options: Partial<Options> = {}) {
    this.config = new Configuration(options)
    this.extension = new Extension()
    this.logger = this.setUpLogger()
    this.storeInGlobal()

    if (this.isActive) {
      this.extension.start()
      this.#metrics = new Metrics()
      this.#sdk = this.initOpenTelemetry(
        options.additionalInstrumentations || []
      )
    } else {
      this.#metrics = new NoopMetrics()
      console.error("AppSignal not starting, no valid configuration found")
    }

    this.initCoreProbes()
  }

  /**
   * Returns `true` if the extension is loaded and configuration is valid
   */
  get isActive(): boolean {
    return (
      Extension.isLoaded &&
      this.config.isValid &&
      (this.config.data.active ?? false)
    )
  }

  set isActive(arg) {
    console.warn("Cannot set isActive property")
  }

  /**
   * Starts AppSignal with the given configuration. If no configuration is set
   * yet it will try to automatically load the configuration using the
   * environment loaded from environment variables and the current working
   * directory.
   */
  public start(): void {
    if (this.config.isValid) {
      this.extension.start()
    } else {
      console.error("Not starting, no valid AppSignal configuration found")
    }
  }

  /**
   * Stops the AppSignal agent.
   *
   * Call this before the end of your program to make sure the
   * agent is stopped as well.
   */
  public stop(calledBy?: string): void {
    if (calledBy) {
      console.log(`Stopping AppSignal (${calledBy})`)
    } else {
      console.log("Stopping AppSignal")
    }

    this.#sdk?.shutdown()
    this.metrics().probes().stop()
    this.extension.stop()
  }

  /**
   * Internal private function used by the demo CLI.
   *
   * https://docs.appsignal.com/nodejs/command-line/demo.html
   *
   * @private
   */
  public demo() {
    demo(this)
  }

  /**
   * Returns the current `Metrics` object.
   *
   * To track application-wide metrics, you can send custom metrics to AppSignal.
   * These metrics enable you to track anything in your application, from newly
   * registered users to database disk usage. These are not replacements for custom
   * instrumentation, but provide an additional way to make certain data in your
   * code more accessible and measurable over time.
   *
   * With different types of metrics (gauges, counters and measurements)
   * you can track any kind of data from your apps and tag them with metadata
   * to easily spot the differences between contexts.
   */
  public metrics(): Metrics {
    return this.#metrics
  }

  /**
   * Initialises all the available probes to attach automatically at runtime.
   */
  private initCoreProbes() {
    const probes: any[] = [gcProbe]

    // load probes
    probes.forEach(({ PROBE_NAME, init }) =>
      this.#metrics.probes().register(PROBE_NAME, init(this.#metrics))
    )
  }

  private defaultInstrumentationsConfig(): DefaultInstrumentationsConfigMap {
    const sendParams = this.config.data.sendParams
    const sendSessionData = this.config.data.sendSessionData
    const requestHeaders = this.config.data.requestHeaders

    return {
      "@opentelemetry/instrumentation-express": {
        requestHook: function (_span, info) {
          if (info.layerType === ExpressLayerType.REQUEST_HANDLER) {
            if (sendParams) {
              const queryParams = info.request.query
              const requestBody = info.request.body
              const params = { ...queryParams, ...requestBody }
              setParams(params)
            }

            if (sendSessionData) {
              setSessionData(info.request.cookies)
            }
          }
        }
      },
      "@opentelemetry/instrumentation-http": {
        headersToSpanAttributes: {
          server: { requestHeaders }
        }
      },
      "@opentelemetry/instrumentation-ioredis": {
        dbStatementSerializer: RedisDbStatementSerializer
      },
      "@opentelemetry/instrumentation-koa": {
        requestHook: function (_span, info) {
          if (sendParams) {
            const queryParams = info.context.request.query
            setParams(queryParams)
          }
        }
      },
      "@opentelemetry/instrumentation-redis": {
        dbStatementSerializer: RedisDbStatementSerializer
      },
      "@opentelemetry/instrumentation-redis-4": {
        dbStatementSerializer: RedisDbStatementSerializer
      },
      "@prisma/instrumentation": {
        middleware: true
      }
    }
  }

  private defaultInstrumentations(): Instrumentation[] {
    const disabledInstrumentations =
      this.config.data.disableDefaultInstrumentations
    if (disabledInstrumentations === true) {
      return []
    }

    const instrumentationConfigs =
      this.defaultInstrumentationsConfig() as Record<string, any>
    return Object.entries(DefaultInstrumentations)
      .filter(
        ([name, _constructor]) =>
          !(disabledInstrumentations || ([] as string[])).includes(name)
      )
      .map(
        ([name, constructor]) =>
          new constructor(instrumentationConfigs[name] || {})
      )
  }

  /**
   * Initialises OpenTelemetry instrumentation
   */
  private initOpenTelemetry(
    additionalInstrumentations: AdditionalInstrumentationsOption
  ) {
    const instrumentations = additionalInstrumentations.concat(
      this.defaultInstrumentations()
    )

    const testMode = process.env["_APPSIGNAL_TEST_MODE"]
    const testModeFilePath = process.env["_APPSIGNAL_TEST_MODE_FILE_PATH"]
    let spanProcessor

    if (testMode && testModeFilePath) {
      spanProcessor = new TestModeSpanProcessor(testModeFilePath)
    } else {
      spanProcessor = new SpanProcessor(this)
    }

    const sdk = new NodeSDK({
      instrumentations,
      spanProcessor
    })

    sdk.start()

    return sdk
  }

  /**
   * Sets up the AppSignal logger with the output based on the `log` config option. If
   * the log file is not accessible, stdout will be the output.
   */
  private setUpLogger(): Logger {
    const logFilePath = this.config.logFilePath
    const logLevel = String(this.config.data["logLevel"])
    const logType = String(this.config.data["log"])
    let logger

    if (logType == "file" && logFilePath) {
      logger = new Logger(logType, logLevel, logFilePath)
    } else {
      logger = new Logger(logType, logLevel)
    }

    return logger
  }

  /**
   * Stores the client in global object after initializing
   */
  private storeInGlobal(): void {
    global.__APPSIGNAL__ = this
  }
}
