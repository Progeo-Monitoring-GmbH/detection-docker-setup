import Navbar from './Navbar';

/**
 * Used for views that historically had no sidebar (e.g. the IMEI display).
 * With the top-bar navigation this is identical to Navbar, kept as an alias
 * so routes stay explicit about intent.
 */
const NavbarEmpty = ({ act, content }) => {
  return <Navbar act={act} content={content} />;
};

export default NavbarEmpty;
