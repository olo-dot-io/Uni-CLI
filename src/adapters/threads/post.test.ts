import { describe, expect, it } from "vitest";

import { parseThreadsPostHtml, parseThreadsProfileHtml } from "./post.js";

const postHtml = String.raw`
  <html>
    <head>
      <meta property="og:title" content="Mark Zuckerberg (@zuck) on Threads" />
      <meta property="og:description" content="Today we&#039;re starting to roll out Incognito Chat &amp; private message requests." />
      <meta property="og:url" content="https://www.threads.com/@zuck/post/DYSAIo_FL77" />
      <meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.2885-15/threads-image.jpg" />
      <meta property="og:image:width" content="1920" />
      <meta property="og:image:height" content="1440" />
      <meta property="al:ios:url" content="barcelona://media?shortcode=DYSAIo_FL77" />
      <link rel="alternate" href="https://threads.net/ap/users/17841401746480004/post/17955322232962801/" type="application/activity+json" />
    </head>
  </html>
`;

const profileHtml = String.raw`
  <html>
    <head>
      <meta property="og:title" content="Mark Zuckerberg (@zuck) • Threads, Say more" />
      <meta property="og:description" content="5.5M Followers • 145 Threads • Mostly superintelligence and MMA takes. See the latest conversations with @zuck." />
      <meta property="og:url" content="https://www.threads.com/@zuck" />
      <meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.2885-19/profile.jpg" />
    </head>
  </html>
`;

describe("Threads public page metadata", () => {
  it("extracts a public post from Threads metadata", () => {
    expect(
      parseThreadsPostHtml(
        postHtml,
        "https://www.threads.net/@zuck/post/DYSAIo_FL77",
      ),
    ).toEqual({
      activity_json_url:
        "https://threads.net/ap/users/17841401746480004/post/17955322232962801/",
      author: "Mark Zuckerberg",
      handle: "@zuck",
      image_height: 1440,
      image_url:
        "https://scontent.cdninstagram.com/v/t51.2885-15/threads-image.jpg",
      image_width: 1920,
      shortcode: "DYSAIo_FL77",
      text: "Today we're starting to roll out Incognito Chat & private message requests.",
      url: "https://www.threads.com/@zuck/post/DYSAIo_FL77",
    });
  });

  it("extracts a public profile from Threads metadata", () => {
    expect(parseThreadsProfileHtml(profileHtml, "zuck")).toEqual({
      avatar_url: "https://scontent.cdninstagram.com/v/t51.2885-19/profile.jpg",
      bio: "Mostly superintelligence and MMA takes.",
      followers: "5.5M",
      handle: "@zuck",
      name: "Mark Zuckerberg",
      threads: "145",
      url: "https://www.threads.com/@zuck",
    });
  });
});
