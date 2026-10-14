import { NextResponse } from 'next/server';

/** Back to the Data sources page with an outcome code (relative, so it works behind any proxy). */
export function backToSources(outcome: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: `/connections?schwab=${outcome}` } });
}
