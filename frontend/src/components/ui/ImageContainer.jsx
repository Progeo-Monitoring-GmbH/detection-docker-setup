import React, { useContext } from 'react';
import { TrashFill } from 'react-bootstrap-icons';
import { CoreModalContext } from '../modal/coreModalContext';

const ImageContainer = (props) => {
  const { refFunc, open, image } = props;

  const [modalState, setModalState] = useContext(CoreModalContext);

  console.log(refFunc, open);
  return (
    <div className={'float-start thumbContainer'}>
      <div className={'py-2'}>
        <div className={'thumbHeaderDate mx-2'}>{image.created}</div>
        <div className={'thumbHeaderIcons'}>
          <TrashFill
            className="mx-2"
            onClick={() =>
              setModalState({
                ...modalState,
                id: image.id,
                modalDeleteFile: true,
                type: 'images',
              })
            }
          />
        </div>
      </div>
      <img
        className={'thumbNailed'}
        alt={image.created}
        ref={refFunc}
        onClick={open}
        src={image.image}
      />
    </div>
  );
};

export default ImageContainer;
