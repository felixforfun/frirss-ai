import { describe, it, expect, vi, afterEach } from 'vitest';
import { isTechmemePermalink, publisherLink, sameTechmemeStory, tagText, resolveFromFeed } from './techmeme.js';

// Fixtures are REAL items from https://www.techmeme.com/feed.xml?x=1
// (2026-10-24), with only whitespace trimmed. They cover the two description
// shapes the feed actually emits:
//   - `<A HREF="publisher"><IMG SRC="techmeme/…/i28.jpg"></A>` (lead photo)
//   - no image at all — the publisher URL then only exists in the bold
//     headline anchor (`<B><A HREF="publisher">Headline</A></B>`)
const ITEM_WITH_LEAD_IMAGE = `
<item>
  <title>Google updates its privacy policy to clarify it could use data shared via Personal Intelligence from connected apps, including Gmail and Photos, to target ads (Shimul Sood/Android Authority)</title>
  <link>https://www.techmeme.com/261023/p28#a261023p28</link>
  <description><![CDATA[<A HREF="https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/"><IMG VSPACE="4" HSPACE="4" BORDER="0" ALIGN="RIGHT" SRC="http://www.techmeme.com/261023/i28.jpg"></A>
<P><A HREF="https://www.techmeme.com/261023/p28#a261023p28" TITLE="Techmeme permalink"><IMG WIDTH=11 HEIGHT=12 SRC="http://www.techmeme.com/img/pml.png" STYLE="border:none;padding:0;margin:0;"></A> Shimul Sood / <A HREF="https://www.androidauthority.com/">Android Authority</A>:<BR>
<SPAN STYLE="font-size:1.3em;"><B><A HREF="https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/">Google updates its privacy policy to clarify it could use data shared via Personal Intelligence from connected apps, including Gmail and Photos, to target ads</A></B></SPAN>&nbsp; &mdash;&nbsp; Your inbox has secrets &hellip; </P>
]]></description>
  <pubDate>Fri, 23 Oct 2026 23:45:01 -0400</pubDate>
  <guid>https://www.techmeme.com/261023/p28#a261023p28</guid>
</item>
`;

const ITEM_WITHOUT_LEAD_IMAGE = `
<item>
  <title>Andy Jassy says AWS capacity for 2027 is "largely sold out" and a "good chunk" of 2028 capacity is also sold, though AWS reserves some capacity for on-demand (Catherine Perloff/The Information)</title>
  <link>https://www.techmeme.com/261023/p27#a261023p27</link>
  <description><![CDATA[<P><A HREF="https://www.techmeme.com/261023/p27#a261023p27" TITLE="Techmeme permalink"><IMG WIDTH=11 HEIGHT=12 SRC="http://www.techmeme.com/img/pml.png" STYLE="border:none;padding:0;margin:0;"></A> Catherine Perloff / <A HREF="https://www.theinformation.com/">The Information</A>:<BR>
<SPAN STYLE="font-size:1.3em;"><B><A HREF="https://www.theinformation.com/briefings/aws-sold-capacity-2028-jassy-says">Andy Jassy says AWS capacity for 2027 is "largely sold out" and a "good chunk" of 2028 capacity is also sold, though AWS reserves some capacity for on-demand</A></B></SPAN>&nbsp; &mdash;&nbsp; Amazon Web Services capacity is mostly booked up &hellip; </P>
]]></description>
  <pubDate>Fri, 23 Oct 2026 22:55:01 -0400</pubDate>
  <guid>https://www.techmeme.com/261023/p27#a261023p27</guid>
</item>
`;

const FEED_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Techmeme</title>${ITEM_WITH_LEAD_IMAGE}${ITEM_WITHOUT_LEAD_IMAGE}</channel></rss>`;

function feedResponse(xml: string): typeof fetch {
  return vi.fn(async () => new Response(xml, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isTechmemePermalink', () => {
  it('accepts Techmeme story permalinks, with or without day prefix and fragment', () => {
    for (const url of [
      'https://www.techmeme.com/261023/p28#a261023p28',
      'https://www.techmeme.com/261023/p28',
      'https://www.techmeme.com/p28#a261023p28',
      'http://www.techmeme.com/261023/p28',
    ]) {
      expect(isTechmemePermalink(url)?.pathname, url).toBeTruthy();
    }
  });

  it('rejects non-Techmeme hosts, non-permalink paths and bad input', () => {
    for (const url of [
      'https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/',
      'https://www.techmeme.com/',
      'https://www.techmeme.com/feed.xml',
      'https://www.techmeme.com/261023/p28/not-a-story',
      'ftp://www.techmeme.com/261023/p28',
      'not a URL',
    ]) {
      expect(isTechmemePermalink(url), url).toBeNull();
    }
  });
});

describe('sameTechmemeStory', () => {
  it('ignores the fragment and trailing slash that feed links decorate', () => {
    expect(sameTechmemeStory('https://www.techmeme.com/261023/p28#a261023p28', 'https://www.techmeme.com/261023/p28')).toBe(true);
  });

  it('stays distinct across stories and hosts', () => {
    expect(sameTechmemeStory('https://www.techmeme.com/261023/p27', 'https://www.techmeme.com/261023/p28')).toBe(false);
    expect(sameTechmemeStory('https://example.com/261023/p28', 'https://www.techmeme.com/261023/p28')).toBe(false);
  });
});

describe('publisherLink', () => {
  it('takes the publisher URL from the lead-image anchor', () => {
    expect(publisherLink(tagText(ITEM_WITH_LEAD_IMAGE, 'description')))
      .toBe('https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/');
  });

  it('falls back to the bold headline anchor when no image anchor carries a publisher URL', () => {
    // The permalink-and-pml icon anchor also contains an <IMG> but points back
    // to techmeme.com and must be skipped, so the only usable URL is the one
    // inside <B>.
    expect(publisherLink(tagText(ITEM_WITHOUT_LEAD_IMAGE, 'description')))
      .toBe('https://www.theinformation.com/briefings/aws-sold-capacity-2028-jassy-says');
  });

  it('returns null for an empty description', () => {
    expect(publisherLink('')).toBeNull();
  });
});

describe('resolveFromFeed', () => {
  it('resolves the 2026-10-23 Personal Intelligence story to Android Authority', async () => {
    const requested = isTechmemePermalink('https://www.techmeme.com/261023/p28#a261023p28')!;
    expect(await resolveFromFeed(requested, feedResponse(FEED_FIXTURE)))
      .toBe('https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/');
  });

  it('resolves the same story when the requested URL carries no fragment', async () => {
    const requested = isTechmemePermalink('https://www.techmeme.com/261023/p28')!;
    expect(await resolveFromFeed(requested, feedResponse(FEED_FIXTURE)))
      .toBe('https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/');
  });

  it('resolves imageless items through the headline anchor', async () => {
    const requested = isTechmemePermalink('https://www.techmeme.com/261023/p27#a261023p27')!;
    expect(await resolveFromFeed(requested, feedResponse(FEED_FIXTURE)))
      .toBe('https://www.theinformation.com/briefings/aws-sold-capacity-2028-jassy-says');
  });

  it('returns null when the story is no longer in the feed', async () => {
    const requested = isTechmemePermalink('https://www.techmeme.com/230101/p99#a230101p99')!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await resolveFromFeed(requested, feedResponse(FEED_FIXTURE))).toBeNull();
    expect(warn).toHaveBeenCalledWith('[techmeme] resolve miss: story not in feed');
  });

  it('returns null when the feed request fails (HTTP/network/timeout)', async () => {
    const requested = isTechmemePermalink('https://www.techmeme.com/261023/p28')!;
    const failing = vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await resolveFromFeed(requested, failing)).toBeNull();
  });

  it('aborts and returns null when the feed never answers', async () => {
    const requested = isTechmemePermalink('https://www.techmeme.com/261023/p28')!;
    const never = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')));
      });
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const pending = resolveFromFeed(requested, never);
      const settled = vi.fn();
      void pending.then(settled);
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.runAllTimersAsync();
      expect(await pending).toBeNull();
      expect(settled).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
