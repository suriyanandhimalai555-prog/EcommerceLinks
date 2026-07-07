import { Kafka, Producer, Consumer, logLevel } from 'kafkajs'
import { CFG } from '../config.js'

let _kafka: Kafka | undefined
let _producer: Producer | undefined

export function kafka(): Kafka {
  if (!_kafka) {
    _kafka = new Kafka({
      clientId: 'avg-backend',
      brokers: CFG.KAFKA_BROKERS,
      logLevel: logLevel.WARN,
    })
  }
  return _kafka
}

export async function getProducer(): Promise<Producer> {
  if (!_producer) {
    _producer = kafka().producer({
      idempotent: true,
      maxInFlightRequests: 1,
    })
    await _producer.connect()
  }
  return _producer
}

export function createConsumer(groupId: string): Consumer {
  return kafka().consumer({ groupId })
}
