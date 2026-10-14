import { describe, expect, it } from "vitest";
import { transcriptImages, transcriptToolImages } from "../src/claude/attachments.js";

describe("transcriptImages", () => {
  const messages = [
    { type: "user", uuid: "a", message: { content: "nur Text" } },
    {
      type: "user",
      uuid: "b",
      message: {
        content: [
          { type: "text", text: "Schau mal" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "PDF" } },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } },
          { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
        ],
      },
    },
  ];

  it("returns the base64 images of the message in order", () => {
    expect(transcriptImages(messages, "b")).toEqual([
      { mediaType: "image/png", base64: "AAA" },
      { mediaType: "image/jpeg", base64: "BBB" },
    ]);
  });

  it("returns an empty list for a message without images and null for an unknown one", () => {
    expect(transcriptImages(messages, "a")).toEqual([]);
    expect(transcriptImages(messages, "zzz")).toBeNull();
  });
});

describe("transcriptToolImages", () => {
  const messages = [
    { type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__forge__preview_screenshot", input: {} }] } },
    {
      type: "user",
      uuid: "b",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu0", content: "nur Text" },
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: [
              { type: "text", text: "Titel: Start" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "JPG" } },
              { type: "image", data: "PNG", mimeType: "image/png" },
            ],
          },
        ],
      },
    },
  ];

  it("returns the images of one tool result", () => {
    expect(transcriptToolImages(messages, "tu1")).toEqual([
      { mediaType: "image/jpeg", base64: "JPG" },
      { mediaType: "image/png", base64: "PNG" },
    ]);
    expect(transcriptToolImages(messages, "tu0")).toEqual([]);
    expect(transcriptToolImages(messages, "tu9")).toBeNull();
  });
});
