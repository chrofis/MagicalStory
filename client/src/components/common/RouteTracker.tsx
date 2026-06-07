import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { trackPageView } from '../../utils/analytics';

// Fires a GA4 page_view on every SPA route change. The gtag GA4 config uses
// send_page_view:false, so without this only the first load would be counted —
// this is what lets us see the full on-site journey (e.g. /try → next page).
export function RouteTracker() {
  const location = useLocation();
  useEffect(() => {
    trackPageView(location.pathname + location.search);
  }, [location.pathname, location.search]);
  return null;
}
