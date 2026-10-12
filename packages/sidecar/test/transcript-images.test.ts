import { describe, expect, it } from "vitest";
import { transcriptImages } from "../src/claude/attachments.js";

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
