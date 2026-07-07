import { kafka } from '../src/lib/kafka.js'
import { TOPICS } from '../src/events/topics.js'
import 'dotenv/config'

async function createTopics() {
  const admin = kafka().admin()
  await admin.connect()

  try {
    const topicConfigs = Object.values(TOPICS).map((t) => ({
      topic:             t.name,
      numPartitions:     t.partitions,
      replicationFactor: 1,
    }))

    // createTopics is idempotent when allowAutoTopicCreation handled
    const created = await admin.createTopics({
      topics:              topicConfigs,
      waitForLeaders:      true,
    })
    console.log(created ? 'Topics created.' : 'Topics already exist (no-op).')

    const metadata = await admin.fetchTopicMetadata({ topics: topicConfigs.map((t) => t.topic) })
    for (const t of metadata.topics) {
      console.log(`  ${t.name}: ${t.partitions.length} partitions`)
    }
  } finally {
    await admin.disconnect()
  }
}

createTopics().catch((err) => {
  console.error('createTopics failed:', err)
  process.exit(1)
})
