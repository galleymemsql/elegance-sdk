import type {
  Connection,
  ChatCompletionBody,
  ChatCompletionResult,
  AggregateQuery,
  CreateChatCompletionBody
} from "../../shared/types";
import type { AI } from "../utils";
import { handleError } from "../../shared/helpers";

export const createChatCompletionController = <T extends Connection>(connection: T, ai: AI) => {
  return async (body: ChatCompletionBody[T["type"]]): Promise<ChatCompletionResult> => {
    try {
      let result: ChatCompletionResult | undefined = undefined;

      const {
        db,
        collection,
        prompt,
        model,
        textField = "text",
        embeddingField = "embedding",
        minSimilarity = 0.7,
        systemRole = "You are a helpful assistant.",
        messages: restMessages = [],
        maxTokens,
        maxContextLength,
        temperature
      } = body;

      if (!prompt) throw new Error("Prompt is required");

      const promptEmbedding = (await ai.createEmbedding(prompt))[0];
      let searchResults: any[] | undefined = undefined;

      if (connection.type === "kai") {
        const query: AggregateQuery = [
          {
            $addFields: {
              similarity: { $dotProduct: [`$${embeddingField}`, ai.embeddingToBuffer(promptEmbedding)] }
            }
          },
          { $project: { [textField]: 1, similarity: 1 } },
          { $sort: { similarity: -1 } }
        ];

        searchResults = await connection.db(db).collection(collection).aggregate(query).toArray();
      } else {
        const tablePath = connection.tablePath(collection, db);

        const query = `SELECT ${textField}, DOT_PRODUCT(${embeddingField}, JSON_ARRAY_PACK('[${promptEmbedding}]')) AS similarity FROM ${tablePath} ORDER BY similarity DESC`;

        searchResults = ((await connection.execute(query))[0] as any[]).map(i => {
          delete i[embeddingField];
          return i;
        });
      }

      if (!searchResults) throw new Error("No search results");

      if (typeof minSimilarity === "number") {
        searchResults = searchResults.filter(({ similarity }) => similarity >= minSimilarity);
      }

      const context = [...searchResults]
        .map(i => i[textField])
        .join("\n")
        .slice(0, maxContextLength);

      let messages: CreateChatCompletionBody["messages"] = [{ role: "system", content: systemRole }];

      if (prompt) {
        messages.push({
          role: "user",
          content: `The user wrote: ${prompt}. The most similar context is: ${context}`
        });
      }

      messages = [...messages, ...restMessages];

      const content = await ai.createChatCompletion({
        prompt,
        promptEmbedding,
        model,
        temperature,
        searchResults,
        messages,
        maxTokens,
        maxContextLength,
        minSimilarity
      });

      result = { content: content ?? "", context };

      return result;
    } catch (error) {
      throw handleError(error);
    }
  };
};
