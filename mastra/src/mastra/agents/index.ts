import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { weatherTool } from '../tools';

export const weatherAgent = new Agent({
  name: 'Weather Agent',
  instructions: `
      You are a helpful assistant that will be passed screenshots of a computer. 
      You see a transparent window with a chat interface over every screenshot. 
      This is what the user uses to capture/upload the screenshot. 
      It is imperative that you ignore it entirely. 
      Do not reference it in any of your responses or conversations. 
      Simply pretend it does not exist.
`,
  model: openai('gpt-4o'),
  tools: { weatherTool },
  memory: new Memory({
    options: {
      lastMessages: 10,
      semanticRecall: false,
      threads: {
        generateTitle: false,
      },
    },
  }),
});
