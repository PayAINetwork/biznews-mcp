import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createMcpPaidHandler } from "mcpay/handler";
import { z } from "zod";
import "dotenv/config";
import OpenAI from "openai";

const app = new Hono();


type NewsApiArticle = {
    uuid?: string;
    title?: string;
    description?: string | null;
    keywords?: string | null;
    snippet?: string | null;
    url?: string;
    image_url?: string | null;
    language?: string;
    published_at?: string;
    source?: string | null;
    categories?: string[] | null;
    relevance_score?: number | null;
    locale?: string | null;
};

type NewsApiMeta = {
    found: number;
    returned: number;
    limit: number;
    page: number;
};

type NewsApiResponse = {
    meta: NewsApiMeta;
    data: NewsApiArticle[];
};

const THE_NEWS_API_URL = "https://api.thenewsapi.com/v1/news/top?language=en";

function mapTheNewsApiToNewsApiArticles(json: unknown): NewsApiArticle[] {
    const root = json as { data?: unknown };
    const data = root && typeof root === "object" ? (root as any).data : undefined;
    let items: any[] = [];

    if (Array.isArray(data)) {
        items = data as any[];
    } else if (data && typeof data === "object") {
        for (const value of Object.values(data as Record<string, unknown>)) {
            if (Array.isArray(value)) {
                items.push(...(value as any[]));
            }
        }
    }

    return items.map((a: any): NewsApiArticle => ({
        uuid: a?.uuid,
        title: a?.title ?? undefined,
        description: a?.description ?? null,
        keywords: a?.keywords ?? null,
        snippet: a?.snippet ?? null,
        url: a?.url ?? undefined,
        image_url: a?.image_url ?? null,
        language: a?.language ?? undefined,
        published_at: a?.published_at ?? undefined,
        source: typeof a?.source === "string" ? a.source : (a?.source?.domain ?? null),
        categories: Array.isArray(a?.categories) ? a.categories : null,
        relevance_score: typeof a?.relevance_score === "number" ? a.relevance_score : null,
        locale: a?.locale ?? null,
    }));
}

async function fetchTopHeadlines(): Promise<NewsApiResponse> {
    const apiKey = process.env.THENEWSAPI_KEY || "";
    const newsUrl = `${THE_NEWS_API_URL}&api_token=${encodeURIComponent(apiKey)}`;
    const res = await fetch(newsUrl);
    if (!res.ok) {
        throw new Error("Failed to fetch top headlines");
    }
    const raw = await res.json();
    const articles = mapTheNewsApiToNewsApiArticles(raw);
    const meta: NewsApiMeta = {
        found: articles.length,
        returned: articles.length,
        limit: articles.length,
        page: 1,
    };
    return { meta, data: articles };
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
            "Return unfiltered top US headlines from TheNewsAPI",
            {},
            async () => {
                try {
                    const newsData = await fetchTopHeadlines();
                    return toolJson(newsData);
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
                    console.log("newsData in paid tool: ", newsData);

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
                                    "Return strictly valid JSON array of articles from the provided input. Input JSON follows NewsAPI-like structure with an 'articles' array. Output must be a JSON array of article objects that were selected, preserving original fields.\n\nInput:" +
                                    "\n\n" +
                                    JSON.stringify(newsData),
                            },
                        ],
                        temperature: 0,
                        response_format: { type: "json_object" },
                    });

                    const content = completion.choices?.[0]?.message?.content;
                    console.log("Completion returned from openai: ", content);

                    let filteredArticles: NewsApiArticle[] = [];
                    try {
                        const contentString = typeof content === "string" ? content : "";
                        const parsed = JSON.parse(contentString || "{}");
                        if (Array.isArray(parsed)) {
                            filteredArticles = parsed as NewsApiArticle[];
                        } else if (parsed && Array.isArray(parsed.articles)) {
                            filteredArticles = parsed.articles as NewsApiArticle[];
                        }
                    } catch (err) {
                        console.error(err);
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
            "evm": {address: process.env.EVM_RECIPIENT_ADDRESS as string, isTestnet: false},
            // "svm": {address: process.env.SVM_RECIPIENT_ADDRESS as string, isTestnet: false}
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