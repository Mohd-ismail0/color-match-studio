import { useLocation, Link } from 'react-router-dom';
import { useEffect } from 'react';
import { Header } from '@/components/colorCorrector/Header';
import { Button } from '@/components/ui/button';

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error('404 Error: User attempted to access non-existent route:', location.pathname);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main id="main-content" className="container flex min-h-[60vh] items-center justify-center py-12">
        <div className="text-center space-y-4 max-w-md">
          <h1 className="text-4xl sm:text-5xl font-bold">404</h1>
          <p className="text-lg sm:text-xl text-muted-foreground">Oops! Page not found</p>
          <Button asChild className="min-h-10">
            <Link to="/">Return to Home</Link>
          </Button>
        </div>
      </main>
    </div>
  );
};

export default NotFound;
