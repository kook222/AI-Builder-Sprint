// "openai": "^4.21.0"(https://github.com/openai/openai-node)
 
import OpenAI from "openai";
 
const apiKey = "YOUR_UPSTAGE_API_KEY";
const openai = new OpenAI({
  apiKey,
  baseURL: "https://api.upstage.ai/v1"
});
 
const chatCompletion = await openai.chat.completions.create({
  model: "solar-pro3",
  messages: [
    {
      "role": "user",
      "content": "Hi, how are you?"
    }
  ],
  reasoning_effort: "high", 
  stream: true
});
 
for await (const chunk of chatCompletion) {
  console.log(chunk.choices[0]?.delta?.content || "");
}
 
// Use with stream=false
// console.log(chatCompletion.choices[0].message.content || "");