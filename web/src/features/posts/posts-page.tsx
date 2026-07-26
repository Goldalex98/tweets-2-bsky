import { ArrowUpRight, Heart, Loader2, MessageCircle, Quote, Repeat2, UserRound } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { DebouncedInput } from '../../components/ui/debounced-input';
import { Label } from '../../components/ui/label';
import {
  buildFacetSegments,
  formatCompactNumber,
  formatLocalDateTime,
  getMappingGroupMeta,
  getTwitterPostUrl,
  selectClassName,
} from '../../lib/dashboard-utils';
import { cn } from '../../lib/utils';
import type { EnrichedPost, LocalPostSearchResult } from '../activity/types';
import type { AccountMapping, BskyProfileView } from '../destinations/types';

interface PostsPageProps {
  searchQuery: string;
  onSearchQueryChange(value: string): void;
  searching: boolean;
  groupFilter: string;
  onGroupFilterChange(value: string): void;
  groupOptions: Array<{ key: string; name: string; emoji: string }>;
  localResults: LocalPostSearchResult[];
  posts: EnrichedPost[];
  resolveLocalMapping(post: LocalPostSearchResult): AccountMapping | undefined;
  resolvePostMapping(post: EnrichedPost): AccountMapping | undefined;
  getProfile(actor: string): BskyProfileView | undefined;
  error?: string | null;
}

export function PostsPage({
  searchQuery,
  onSearchQueryChange,
  searching,
  groupFilter,
  onGroupFilterChange,
  groupOptions,
  localResults,
  posts,
  resolveLocalMapping,
  resolvePostMapping,
  getProfile,
  error,
}: PostsPageProps) {
  return (
    <section className="space-y-6 animate-fade-in" aria-labelledby="posts-title">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle id="posts-title">Already Posted</CardTitle>
              <CardDescription>Native-styled feed plus local SQLite search across all crossposted history.</CardDescription>
            </div>
            <div className="grid w-full gap-2 md:max-w-2xl md:grid-cols-[1fr_240px]">
              <div className="space-y-1">
                <Label htmlFor="posts-search">Search crossposted posts</Label>
                <div className="relative">
                  <DebouncedInput
                    id="posts-search"
                    value={searchQuery}
                    onChange={onSearchQueryChange}
                    placeholder="Search by text, @username, tweet id, or Bluesky handle"
                  />
                  {searching ? (
                    <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="posts-group-filter">Filter group</Label>
                <select
                  id="posts-group-filter"
                  className={selectClassName}
                  value={groupFilter}
                  onChange={(event) => onGroupFilterChange(event.target.value)}
                >
                  <option value="all">All folders</option>
                  {groupOptions.map((group) => (
                    <option key={group.key} value={group.key}>{group.emoji} {group.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0" aria-live="polite">
          {error ? <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          {searchQuery.trim() ? (
            localResults.length === 0 ? (
              <Empty>{searching ? 'Searching local history...' : 'No local crossposted posts matched.'}</Empty>
            ) : (
              <div className="space-y-2">
                {localResults.map((post) => (
                  <LocalPostCard key={`${post.twitterId}-${post.bskyIdentifier}-${post.bskyCid || post.createdAt || 'result'}`} post={post} mapping={resolveLocalMapping(post)} />
                ))}
              </div>
            )
          ) : posts.length === 0 ? (
            <Empty>No posted entries yet.</Empty>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {posts.map((post, index) => (
                <FeedPostCard
                  key={post.bskyUri || `${post.bskyCid || 'post'}-${post.createdAt || index}`}
                  post={post}
                  mapping={resolvePostMapping(post)}
                  profile={getProfile(post.author.handle)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function LocalPostCard({ post, mapping }: { post: LocalPostSearchResult; mapping?: AccountMapping }) {
  const group = getMappingGroupMeta(mapping);
  const sourceUrl = post.twitterUrl || getTwitterPostUrl(post.twitterUsername, post.twitterId);
  const postUrl =
    post.postUrl ||
    (post.bskyUri
      ? `https://bsky.app/profile/${post.bskyIdentifier}/post/${post.bskyUri.split('/').filter(Boolean).pop() || ''}`
      : undefined);
  return (
    <article className="rounded-lg border border-border/70 bg-background p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">@{post.bskyIdentifier} <span className="text-muted-foreground">from @{post.twitterUsername}</span></p>
          <p className="text-xs text-muted-foreground">{formatLocalDateTime(post.createdAt)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{group.emoji} {group.name}</Badge>
          <Badge variant="secondary">Relevance {Math.round(post.score)}</Badge>
        </div>
      </div>
      <p className="mb-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{post.tweetText || 'No local tweet text stored for this record.'}</p>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-mono">Tweet ID: {post.twitterId}</span>
        <PostLink href={sourceUrl} label="Source" />
        <PostLink href={postUrl} label="Bluesky" />
      </div>
    </article>
  );
}

function FeedPostCard({
  post,
  mapping,
  profile,
}: {
  post: EnrichedPost;
  mapping?: AccountMapping;
  profile?: BskyProfileView;
}) {
  const postUrl =
    post.postUrl ||
    (post.bskyUri
      ? `https://bsky.app/profile/${post.bskyIdentifier}/post/${post.bskyUri.split('/').filter(Boolean).pop() || ''}`
      : undefined);
  const sourceUrl = post.twitterUrl || getTwitterPostUrl(post.twitterUsername, post.twitterId);
  const segments = buildFacetSegments(post.text, post.facets || []);
  const group = getMappingGroupMeta(mapping);
  const avatar = post.author.avatar || profile?.avatar;
  const handle = post.author.handle || post.bskyIdentifier;
  const name = post.author.displayName || handle;
  const stats = [
    { key: 'likes', value: post.stats.likes, icon: Heart },
    { key: 'reposts', value: post.stats.reposts, icon: Repeat2 },
    { key: 'replies', value: post.stats.replies, icon: MessageCircle },
    { key: 'quotes', value: post.stats.quotes, icon: Quote },
  ].filter((item) => item.value > 0);

  return (
    <article className="cv-auto rounded-lg border border-border bg-background p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {avatar ? (
            <img className="h-9 w-9 rounded-full border border-border/70 object-cover" src={avatar} alt={`${name} avatar`} loading="lazy" />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-muted text-muted-foreground"><UserRound className="h-4 w-4" /></div>
          )}
          <div><p className="text-sm font-semibold">{name}</p><p className="text-xs text-muted-foreground">@{handle} • from @{post.twitterUsername}</p></div>
        </div>
        <div className="flex items-center gap-2"><Badge variant="outline">{group.emoji} {group.name}</Badge><Badge variant="success">Posted</Badge></div>
      </div>
      <p className="mb-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
        {segments.map((segment, index) => {
          if (segment.type === 'text') return <span key={`${post.bskyUri}-${index}`}>{segment.text}</span>;
          const tone =
            segment.type === 'mention'
              ? 'text-cyan-600 dark:text-cyan-300'
              : segment.type === 'tag'
                ? 'text-indigo-600 dark:text-indigo-300'
                : 'text-sky-600 dark:text-sky-300';
          return <a key={`${post.bskyUri}-${index}`} className={cn('hover:underline', tone)} href={segment.href} target="_blank" rel="noreferrer">{segment.text}</a>;
        })}
      </p>
      {post.media.length > 0 ? (
        <div className="mb-3 grid gap-2">
          {post.media.map((media, index) => {
            const href = media.url || media.thumb;
            if (!href) return null;
            return (
              <a key={`${post.bskyUri}-media-${index}`} className="block overflow-hidden rounded-lg border border-border/70 bg-muted" href={href} target="_blank" rel="noreferrer">
                {media.thumb || media.type === 'image' ? (
                  <img className="h-56 w-full object-cover" src={media.thumb || media.url} alt={media.alt || media.title || 'Bluesky media'} loading="lazy" />
                ) : (
                  <span className="block p-3 text-sm">{media.title || 'Open attachment'}</span>
                )}
              </a>
            );
          })}
        </div>
      ) : null}
      {stats.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return <span key={stat.key} className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted px-2 py-1 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" />{formatCompactNumber(stat.value)}</span>;
          })}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{formatLocalDateTime(post.createdAt)}</span>
        <div className="flex items-center gap-3"><PostLink href={sourceUrl} label="Source" /><PostLink href={postUrl} label="Bluesky" /></div>
      </div>
    </article>
  );
}

function PostLink({ href, label }: { href?: string; label: string }) {
  return href ? <a className="inline-flex items-center text-foreground underline-offset-4 hover:underline" href={href} target="_blank" rel="noreferrer">{label}<ArrowUpRight className="ml-1 h-3 w-3" /></a> : null;
}
