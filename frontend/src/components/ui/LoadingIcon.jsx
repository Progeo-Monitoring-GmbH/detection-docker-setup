import {Col} from 'react-bootstrap';
import React from 'react';
import {MoonLoader} from "react-spinners";
import '../ui/css/LoadingIcon.css';

// See https://www.davidhu.io/react-spinners/storybook/?path=/docs/moonloader--docs
const LoadingIcon = () => {
    return (
        <Col className={'loadingIcon'}>
            <MoonLoader
                className={"mx-auto"}
                color="rgba(237, 210, 128, 1)"
                loading
                size={60}
                speedMultiplier={0.45}
            />
        </Col>
    );
};

export default LoadingIcon;
