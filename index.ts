import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createMcpPaidHandler } from "mcpay/handler";
import { z } from "zod";
import "dotenv/config";
import OpenAI from "openai";

const app = new Hono();


type NewsApiArticle = {
    source?: { id: string | null; name: string };
    author?: string | null;
    title?: string;
    description?: string | null;
    url?: string;
    urlToImage?: string | null;
    publishedAt?: string;
    content?: string | null;
};

type NewsApiResponse = {
    status: string;
    totalResults: number;
    articles: NewsApiArticle[];
};

const NEWS_API_URL = "https://newsapi.org/v2/top-headlines?pageSize=100&country=us";

async function fetchTopHeadlines(): Promise<NewsApiResponse> {
    const newsApiKey = process.env.NEWSAPI_API_KEY || "";
    const newsUrl = `${NEWS_API_URL}&apiKey=${encodeURIComponent(newsApiKey)}`;
    const res = await fetch(newsUrl);
    if (!res.ok) {
        throw new Error("Failed to fetch top headlines");
    }
    const data = (await res.json()) as NewsApiResponse;
    return data;
}

function toolJson(data: unknown) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(data),
            },
        ],
    } as any;
}

const handler = createMcpPaidHandler(
    (server) => {
        server.tool(
            "news",
            "Return unfiltered top US headlines from NewsAPI",
            {},
            async () => {
                try {
                    const newsData = await fetchTopHeadlines();
                    return toolJson({ articles: newsData.articles });
                } catch (err) {
                    const message = err instanceof Error ? err.message : "Unknown error";
                    return toolJson({ error: message });
                }
            }
        );

        server.paidTool(
            "business_news",
            "Fetch top US headlines and filter for business-relevant opportunities",
            "$0.05",
            {},
            {},
            async () => {
                try {
                    const newsData = await fetchTopHeadlines();

                    const openaiKey = process.env.OPENAI_API_KEY || "";
                    if (!openaiKey) {
                        return toolJson({ error: "Missing OPENAI_API_KEY" });
                    }

                    const systemPrompt =
                        "Read the following data and return only the articles that can affect existing businesses or create new business opportunities.";

                    const openai = new OpenAI({ apiKey: openaiKey });
                    const completion = await openai.chat.completions.create({
                        model: "gpt-4o-mini",
                        messages: [
                            { role: "system", content: systemPrompt },
                            {
                                role: "user",
                                content:
                                    "Return strictly valid JSON array of articles from the provided input. Input JSON follows NewsAPI structure with an 'articles' array. Output must be a JSON array of article objects that were selected, preserving original fields.\n\nInput:" +
                                    "\n\n" +
                                    JSON.stringify(newsData),
                            },
                        ],
                        temperature: 0,
                        response_format: { type: "json_object" },
                    });

                    const content = completion.choices?.[0]?.message?.content;

                    let filteredArticles: NewsApiArticle[] = [];
                    try {
                        const contentString = typeof content === "string" ? content : "";
                        const parsed = JSON.parse(contentString || "{}");
                        if (Array.isArray(parsed)) {
                            filteredArticles = parsed as NewsApiArticle[];
                        } else if (parsed && Array.isArray(parsed.articles)) {
                            filteredArticles = parsed.articles as NewsApiArticle[];
                        }
                    } catch {
                        filteredArticles = [];
                    }

                    return toolJson({ articles: filteredArticles });
                } catch (err) {
                    const message = err instanceof Error ? err.message : "Unknown error";
                    return toolJson({ error: message });
                }
            }
        );
    },
    {
        facilitator: {
            url: process.env.FACILITATOR_URL as `${string}://${string}`
        },
        recipient: {
            "evm": {address: process.env.EVM_RECIPIENT_ADDRESS as string, isTestnet: true},
            "svm": {address: process.env.SVM_RECIPIENT_ADDRESS as string, isTestnet: true}
        }
    },
    {
        serverInfo: { name: "biznews-mcp", version: "1.0.0" },
    },
    {
        maxDuration: 300,
        verboseLogs: true
    }
);

app.use("*", (c) => {
    console.log("[MCP] Request received");
    console.log("[MCP] Request headers:", c.req.raw.headers);
    console.log("[MCP] Request body:", c.req.raw.body);
    console.log("[MCP] Request url:", c.req.raw.url);
    console.log("[MCP] Request method:", c.req.raw.method);
    console.log("[MCP] Request headers:", c.req.raw.headers);
    console.log("[MCP] Request body:", c.req.raw.body);
    console.log("[MCP] Request url:", c.req.raw.url);
    console.log("[MCP] Request method:", c.req.raw.method);
    return handler(c.req.raw);
});

serve({
    fetch: app.fetch,
    port: 3011,
});

console.log("Server is running on port http://localhost:3011");